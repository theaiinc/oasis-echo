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
        self.model = None  # type: ignore[assignment]
        self._buffer: np.ndarray = np.array([], dtype=np.float32)
        self._model_loaded = False
        self.speaker_model = None  # type: ignore[assignment]
        self._speaker_references: list[np.ndarray] = []

    # ------------------------------------------------------------------
    # Model loading
    # ------------------------------------------------------------------
    def load_model(self) -> None:
        if self._model_loaded:
            return
        from funasr import AutoModel  # type: ignore[import-untyped]

        self.model = AutoModel(
            model="iic/SenseVoiceSmall",
            device="cpu",
            disable_update=True,
        )
        self._model_loaded = True

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
            if not self._model_loaded:
                self.load_model()
            if len(self._buffer) < SAMPLE_RATE * 0.3:  # < 300 ms → skip
                return {"type": response_type, "text": ""}
            # SenseVoiceSmall returns a list of dicts, e.g.
            # [{"text": "<|en|><|NEUTRAL|><|Speech|><|withitn|>Hello world"}]
            # FunASR/modelscope may emit progress bars or timing summaries to
            # stdout. Stdout is our line-delimited JSON protocol, so route that
            # library noise to stderr while inference runs.
            # use_itn=True asks SenseVoice for punctuation + inverse text
            # normalization; without it the raw output has no punctuation
            # or casing, which reads as a corrupted transcript downstream.
            with contextlib.redirect_stdout(sys.stderr):
                result = self.model.generate(
                    input=self._buffer, language="auto", use_itn=True
                )
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
            text = _strip_internal_tags(text)
            return {"type": response_type, "text": text}
        except Exception:
            return {"type": "error", "message": traceback.format_exc()}


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
