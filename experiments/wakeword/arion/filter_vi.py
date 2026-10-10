"""Drop VieNeu positives that PhoWhisper says are not the phrase (TTS sometimes rambles or swallows words)."""
import glob, sys, os, json, numpy as np, re
sys.path.insert(0, os.path.dirname(__file__)); from audio_aug import load_wav
from faster_whisper import WhisperModel
p = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--diepho--PhoWhisper-small-ct2/snapshots/*/"))[0]
m = WhisperModel(p, device="cpu", compute_type="int8", cpu_threads=3)
ROOT = "/Volumes/Data/dev/wakeword-arion/tts"; z = np.zeros(16000, np.float32)
rej = {}; keep = 0
for kind in ["pos_arion", "pos_hey"]:
    for f in sorted(glob.glob(f"{ROOT}/{kind}/vi_*.wav")):
        a = load_wav(f)
        segs, _ = m.transcribe(np.concatenate([z, a, z]), language="vi", beam_size=5, condition_on_previous_text=False, without_timestamps=True)
        t = " ".join(s.text for s in segs).lower().strip()
        words = re.findall(r"\w+", t)
        ok = 1 <= len(words) <= 5 and len(a) / 16000 < 2.3
        if kind == "pos_arion": ok = ok and ("ơi" in t or "nơi" in t)
        else: ok = ok and any(w in t for w in ("hey", "hây", "hê", "hế", "hay", "hệ", "hai", "he"))
        if not ok:
            rej[os.path.basename(f)] = t
            os.makedirs(f"{ROOT}/rejected", exist_ok=True); os.rename(f, f"{ROOT}/rejected/{kind}__{os.path.basename(f)}")
        else: keep += 1
json.dump(rej, open(f"{ROOT}/rejected.json", "w"), ensure_ascii=False, indent=1)
print("kept", keep, "rejected", len(rej))
