#!/usr/bin/env python3
"""VieNeu-TTS (Vietnamese) for the hosted Echo server, over stdin/stdout.

Line-delimited JSON, one request at a time:
  {"type":"preload"}                         -> {"type":"ready","sampleRate":N}
  {"type":"say","id":"x","text":"...","voice":null}
      -> {"type":"chunk","id":"x","pcm":"<base64 int16 LE>"} ... then {"type":"done","id":"x"}
  errors -> {"type":"error","id":"x"|null,"message":"..."}
stderr is logs, not protocol.

Model files are downloaded into real directories (VIENEU_DIR): the Hugging Face
cache keeps them as symlinks into separate blob folders, and ONNX Runtime refuses
an external-data file that resolves outside the model's folder.
"""
import base64
import json
import os
import sys
from pathlib import Path

import numpy as np

MODEL_DIR = Path(os.environ.get("VIENEU_DIR", "/tmp/vieneu"))


def _patch_fetch():
    from huggingface_hub import hf_hub_download
    from vieneu._v3_turbo_engine import onnx_runtime_lite as orl

    def fetch(repo, files, subfolder):
        local = MODEL_DIR / repo.replace("/", "__")
        last = None
        for fn in files:
            try:
                last = hf_hub_download(repo, fn, repo_type="model", subfolder=subfolder or None, local_dir=local)
            except Exception:
                if fn.endswith(".json"):
                    continue
                raise
        return Path(last).parent

    orl.OnnxV3LiteEngine._fetch = staticmethod(fetch)


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def to_pcm16(chunk) -> str:
    audio = np.asarray(chunk, dtype=np.float32).reshape(-1)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    return base64.b64encode(pcm.tobytes()).decode("ascii")


def main():
    _patch_fetch()
    from vieneu import Vieneu

    tts = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            if tts is None:
                tts = Vieneu(precision=os.environ.get("VIENEU_PRECISION", "fp32"))
            if req.get("type") == "preload":
                # The first synthesis after loading is several times slower; pay it here,
                # while the call is still ringing, not on the first reply.
                for _ in tts.infer_stream("Xin chào."):
                    pass
                send({"type": "ready", "sampleRate": tts.sample_rate})
            elif req.get("type") == "say":
                kwargs = {"voice": req["voice"]} if req.get("voice") else {}
                for chunk in tts.infer_stream(req["text"], **kwargs):
                    send({"type": "chunk", "id": req_id, "pcm": to_pcm16(chunk)})
                send({"type": "done", "id": req_id})
            else:
                send({"type": "error", "id": req_id, "message": f"unknown type {req.get('type')}"})
        except Exception as err:  # keep serving after a bad request
            send({"type": "error", "id": req_id, "message": str(err)})


if __name__ == "__main__":
    main()
