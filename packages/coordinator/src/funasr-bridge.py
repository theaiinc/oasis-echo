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

Design notes:
  - The bridge is stateless between inference calls: each `feed`
    replaces the internal buffer rather than appending. The TypeScript
    side manages the rolling buffer and decides what to send.
  - Inference runs on whatever was last fed.
  - stderr is inherited by the parent process (not part of this protocol).
"""

from __future__ import annotations

import base64
import json
import re
import sys
import traceback

import numpy as np

SAMPLE_RATE = 16000
SENSEVOICE_TAG_RE = re.compile(r"<\|[^|]+\|>")


def _strip_internal_tags(text: str) -> str:
    """Remove SenseVoiceSmall special tokens like <|en|>, <|NEUTRAL|>, etc."""
    return SENSEVOICE_TAG_RE.sub("", text).strip()


class FunasrBridge:
    def __init__(self) -> None:
        self.model = None  # type: ignore[assignment]
        self._buffer: np.ndarray = np.array([], dtype=np.float32)
        self._model_loaded = False

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
            result = self.model.generate(input=self._buffer, language="auto")
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

    stdin_bin = sys.stdin.buffer  # binary stream, no buffering surprises
    buf = b""
    while True:
        chunk = stdin_bin.read(65536)
        if not chunk:
            break  # stdin closed -> parent process exited
        buf += chunk
        while b"\n" in buf:
            line_bytes, buf = buf.split(b"\n", 1)
            line = line_bytes.decode("utf-8").strip()
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
            else:
                _respond({"type": "error", "message": f"unknown command: {cmd_type}"})


def _respond(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
