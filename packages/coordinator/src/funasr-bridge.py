#!/usr/bin/env python3
"""
FunASR bridge — communicates with TypeScript via stdin/stdout JSON.

Protocol (line-delimited JSON on stdin/stdout, one command per line):

  Request          ->  Response
  -----               --------
  {"type":"preload"}   {"type":"ready"}
                        {"type":"error","message":"..."}
  {"type":"feed",
   "samples":"<b64>"}  {"type":"ack"}
  {"type":"partial"}   {"type":"partial","text":"<transcript>"}
                        {"type":"error","message":"..."}
  {"type":"finalize"}  {"type":"final","text":"<transcript>"}
                        {"type":"error","message":"..."}
  {"type":"reset"}     {"type":"ack"}
  {"type":"speaker","op":"enroll","samples":"<b64>","sampleRate":24000}
                        {"type":"speaker","op":"compare"}

Design notes:
  - The bridge is stateless between inference calls: each `feed`
    replaces the internal buffer rather than appending. The TypeScript
    side manages the rolling buffer and decides what to send.
  - Inference runs on whatever was last fed.
  - stderr is inherited by the parent process (not part of this protocol).
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import re
import sys
import traceback

import numpy as np

SAMPLE_RATE = 16000
SPEAKER_MODEL_ID = os.environ.get(
    "OASIS_FUNASR_SPK_MODEL",
    "iic/speech_campplus_sv_zh-cn_16k-common",
)
SENSEVOICE_TAG_RE = re.compile(r"<\|[^|]+\|>")

# ASR backend selection.
#   "auto" (default)  -- detect the buffer's language with a small generic
#                         Whisper model, then route to PhoWhisper for
#                         Vietnamese or SenseVoice for everything else.
#   "sensevoice"       -- force the FunASR AutoModel path (Mandarin/
#                         Cantonese/English/Japanese/Korean), skipping LID.
#   "phowhisper"        -- force VinAI's PhoWhisper, skipping LID.
# PhoWhisper is a Whisper checkpoint fine-tuned on 844h of Vietnamese across
# regional accents, state-of-the-art WER on Vietnamese benchmarks
# (arxiv.org/abs/2406.02555) -- SenseVoice's own language set doesn't
# include Vietnamese at all, so "auto" is what makes both usable in the
# same session without the caller having to know which language is coming.
ASR_BACKEND = os.environ.get("OASIS_ASR_BACKEND", "auto").strip().lower()
PHOWHISPER_MODEL_ID = os.environ.get("OASIS_PHOWHISPER_MODEL", "vinai/PhoWhisper-medium")
# Small generic multilingual Whisper used only for language ID in "auto"
# mode -- deliberately NOT PhoWhisper itself, since fine-tuning it on
# Vietnamese-only data would skew its own language detection.
LID_MODEL_ID = os.environ.get("OASIS_LID_MODEL", "openai/whisper-tiny")
# Detected languages routed to PhoWhisper. Whisper's LID has no separate
# Cantonese code (it falls under "zh"), which is fine -- SenseVoice covers
# both "zh" and "yue" already.
LID_LANGUAGES_FOR_PHOWHISPER = {"vi"}


def _strip_internal_tags(text: str) -> str:
    """Remove SenseVoiceSmall special tokens like <|en|>, <|NEUTRAL|>, etc.

    Tags can sit directly between words ("...word<|en|>Next..."), so they
    must be replaced with a space — substituting the empty string welds
    the neighboring words together and corrupts the transcript.
    """
    text = SENSEVOICE_TAG_RE.sub(" ", text)
    return re.sub(r"\s{2,}", " ", text).strip()


class FunasrBridge:
    def __init__(self) -> None:
        self.sensevoice_model = None  # type: ignore[assignment]
        self.phowhisper_model = None  # type: ignore[assignment]
        self.lid_processor = None  # type: ignore[assignment]
        self.lid_model = None  # type: ignore[assignment]
        self._buffer: np.ndarray = np.array([], dtype=np.float32)
        # Cached per-utterance so "auto" mode doesn't pay for a full LID
        # forward pass on every partial tick (~every 900ms) — language
        # doesn't change mid-utterance, so detect once and reuse.
        # Invalidated in cmd_reset.
        self._detected_language: str | None = None
        self.speaker_model = None  # type: ignore[assignment]
        self._speaker_references: list[np.ndarray] = []

    # ------------------------------------------------------------------
    # Model loading
    # ------------------------------------------------------------------
    def load_model(self) -> None:
        """Ensure the model(s) the current backend needs are ready.

        "auto" warms SenseVoice (the majority-language path) AND the LID
        model eagerly, since every "auto" transcription calls
        _detect_language first — leaving LID lazy meant cmd_preload
        finished before the pipeline was actually ready, and the first
        real utterance of every session paid a synchronous from_pretrained
        stall it was supposed to have avoided. PhoWhisper itself stays
        lazy (see _load_phowhisper): most sessions never speak Vietnamese
        and shouldn't pay to load a second full transcription model.
        """
        if ASR_BACKEND == "phowhisper":
            self._load_phowhisper()
        else:
            self._load_sensevoice()
            if ASR_BACKEND == "auto":
                self._load_lid()

    def _load_sensevoice(self) -> None:
        if self.sensevoice_model is not None:
            return
        from funasr import AutoModel  # type: ignore[import-untyped]

        self.sensevoice_model = AutoModel(
            model="iic/SenseVoiceSmall",
            device="cpu",
            disable_update=True,
        )

    def _load_phowhisper(self) -> None:
        if self.phowhisper_model is not None:
            return
        # PhoWhisper is a plain Whisper checkpoint (not a FunASR model-zoo
        # entry), so it loads through transformers' ASR pipeline rather than
        # funasr's AutoModel.
        from transformers import pipeline  # type: ignore[import-untyped]

        self.phowhisper_model = pipeline(
            "automatic-speech-recognition",
            model=PHOWHISPER_MODEL_ID,
            device="cpu",
        )

    def _load_lid(self) -> None:
        if self.lid_model is not None:
            return
        from transformers import (  # type: ignore[import-untyped]
            WhisperForConditionalGeneration,
            WhisperProcessor,
        )

        self.lid_processor = WhisperProcessor.from_pretrained(LID_MODEL_ID)
        self.lid_model = WhisperForConditionalGeneration.from_pretrained(LID_MODEL_ID)
        self.lid_model.eval()

    # ------------------------------------------------------------------
    # Commands
    # ------------------------------------------------------------------
    def cmd_preload(self) -> dict:
        try:
            self.load_model()
            return {"type": "ready"}
        except Exception:
            return {"type": "error", "message": traceback.format_exc()}

    def cmd_feed(self, samples_b64: str) -> dict:
        """Replace internal buffer with the decoded samples (not append)."""
        try:
            raw = base64.b64decode(samples_b64)
            self._buffer = np.frombuffer(raw, dtype=np.float32).copy()
            return {"type": "ack"}
        except Exception:
            return {"type": "error", "message": traceback.format_exc()}

    def cmd_partial(self) -> dict:
        return self._transcribe("partial")

    def cmd_finalize(self) -> dict:
        return self._transcribe("final")

    def cmd_reset(self) -> dict:
        self._buffer = np.array([], dtype=np.float32)
        self._detected_language = None
        return {"type": "ack"}

    def cmd_speaker(self, op: str, samples_b64: str = "", sample_rate: int = SAMPLE_RATE) -> dict:
        """Enroll or compare a voice embedding without affecting ASR state."""
        try:
            if op == "enroll":
                samples = self._decode_samples(samples_b64, sample_rate)
                embedding = self._speaker_embedding(samples)
                if embedding is None:
                    return {"type": "speaker", "ok": False, "reason": "no embedding"}
                self._speaker_references.append(embedding)
                # Keep only a short, recent reference bank. This prevents old
                # voices/clips from becoming a permanent identity profile.
                self._speaker_references = self._speaker_references[-12:]
                return {
                    "type": "speaker",
                    "ok": True,
                    "operation": "enroll",
                    "references": len(self._speaker_references),
                }
            if op == "compare":
                if not self._speaker_references:
                    return {"type": "speaker", "ok": False, "reason": "no reference"}
                embedding = self._speaker_embedding(self._buffer)
                if embedding is None:
                    return {"type": "speaker", "ok": False, "reason": "no embedding"}
                scores = [
                    float(np.dot(embedding, reference))
                    for reference in self._speaker_references
                ]
                return {
                    "type": "speaker",
                    "ok": True,
                    "operation": "compare",
                    "score": max(scores),
                    "references": len(scores),
                }
            return {"type": "error", "message": f"unknown speaker operation: {op}"}
        except Exception:
            return {"type": "error", "message": traceback.format_exc()}

    def _decode_samples(self, samples_b64: str, sample_rate: int) -> np.ndarray:
        raw = base64.b64decode(samples_b64)
        samples = np.frombuffer(raw, dtype=np.float32).copy()
        if sample_rate == SAMPLE_RATE:
            return samples
        if len(samples) < 2 or sample_rate <= 0:
            return np.array([], dtype=np.float32)
        target_len = max(1, round(len(samples) * SAMPLE_RATE / sample_rate))
        source_x = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
        target_x = np.linspace(0.0, 1.0, num=target_len, endpoint=False)
        return np.interp(target_x, source_x, samples).astype(np.float32)

    def _speaker_embedding(self, samples: np.ndarray) -> np.ndarray | None:
        if len(samples) < int(SAMPLE_RATE * 0.7):
            return None
        if self.speaker_model is None:
            from funasr import AutoModel  # type: ignore[import-untyped]

            self.speaker_model = AutoModel(
                model=SPEAKER_MODEL_ID,
                device="cpu",
                disable_update=True,
            )
        with contextlib.redirect_stdout(sys.stderr):
            result = self.speaker_model.generate(input=samples)
        item = result[0] if isinstance(result, list) and result else result
        embedding = item.get("spk_embedding") if isinstance(item, dict) else None
        if embedding is None:
            return None
        if hasattr(embedding, "detach"):
            embedding = embedding.detach().cpu().numpy()
        vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm > 1e-8 else None

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------
    def _transcribe(self, response_type: str) -> dict:
        try:
            self.load_model()
            if len(self._buffer) < SAMPLE_RATE * 0.3:  # < 300 ms → skip
                return {"type": response_type, "text": ""}
            # FunASR/modelscope (and transformers) may emit progress bars or
            # timing summaries to stdout. Stdout is our line-delimited JSON
            # protocol, so route that library noise to stderr while
            # inference runs.
            with contextlib.redirect_stdout(sys.stderr):
                if ASR_BACKEND == "phowhisper":
                    text = self._transcribe_phowhisper()
                elif ASR_BACKEND == "sensevoice":
                    text = self._transcribe_sensevoice()
                else:
                    if self._detected_language is None:
                        self._detected_language = self._detect_language(self._buffer)
                    language = self._detected_language
                    if language in LID_LANGUAGES_FOR_PHOWHISPER:
                        self._load_phowhisper()
                        text = self._transcribe_phowhisper()
                    else:
                        text = self._transcribe_sensevoice()
            return {"type": response_type, "text": text}
        except Exception:
            return {"type": "error", "message": traceback.format_exc()}

    def _detect_language(self, samples: np.ndarray) -> str:
        """Return a Whisper language code (e.g. "vi", "en", "zh") for samples."""
        self._load_lid()
        inputs = self.lid_processor(samples, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        lang_ids = self.lid_model.detect_language(inputs.input_features)
        token = self.lid_processor.tokenizer.decode(lang_ids)
        return token.strip("<|>")

    def _transcribe_sensevoice(self) -> str:
        # SenseVoiceSmall returns a list of dicts, e.g.
        # [{"text": "<|en|><|NEUTRAL|><|Speech|><|withitn|>Hello world"}]
        # use_itn=True asks SenseVoice for punctuation + inverse text
        # normalization; without it the raw output has no punctuation
        # or casing, which reads as a corrupted transcript downstream.
        result = self.sensevoice_model.generate(input=self._buffer, language="auto", use_itn=True)
        text = ""
        if isinstance(result, list):
            parts: list[str] = []
            for item in result:
                if isinstance(item, dict):
                    t = item.get("text") or item.get("text_label", "")
                    if isinstance(t, str):
                        parts.append(t)
                elif isinstance(item, str):
                    parts.append(item)
            text = " ".join(parts)
        elif isinstance(result, dict):
            text = result.get("text") or ""
        elif isinstance(result, str):
            text = result
        return _strip_internal_tags(text)

    def _transcribe_phowhisper(self) -> str:
        # transformers' ASR pipeline takes a plain float32 array at the
        # model's native sample rate; PhoWhisper (like all Whisper
        # checkpoints) expects 16 kHz, which is already SAMPLE_RATE here.
        result = self.phowhisper_model({"raw": self._buffer, "sampling_rate": SAMPLE_RATE})
        text = result.get("text", "") if isinstance(result, dict) else str(result)
        return text.strip()


def main() -> None:
    bridge = FunasrBridge()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            _respond({"type": "error", "message": f"json decode: {exc}"})
            continue

        cmd_type = cmd.get("type")
        if cmd_type == "preload":
            _respond(bridge.cmd_preload())
        elif cmd_type == "feed":
            _respond(bridge.cmd_feed(cmd.get("samples", "")))
        elif cmd_type == "partial":
            _respond(bridge.cmd_partial())
        elif cmd_type == "finalize":
            _respond(bridge.cmd_finalize())
        elif cmd_type == "reset":
            _respond(bridge.cmd_reset())
        elif cmd_type == "speaker":
            _respond(
                bridge.cmd_speaker(
                    str(cmd.get("op", "")),
                    str(cmd.get("samples", "")),
                    int(cmd.get("sampleRate", SAMPLE_RATE)),
                )
            )
        else:
            _respond({"type": "error", "message": f"unknown command: {cmd_type}"})


def _respond(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
