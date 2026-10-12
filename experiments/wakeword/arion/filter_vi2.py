"""v2 filter for VieNeu single-word clips: drop rambling (too long / too many words per PhoWhisper)."""
import glob, sys, os, json, numpy as np, re
sys.path.insert(0, os.path.dirname(__file__)); from audio_aug import load_wav
from faster_whisper import WhisperModel
p = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--diepho--PhoWhisper-small-ct2/snapshots/*/"))[0]
m = WhisperModel(p, device="cpu", compute_type="int8", cpu_threads=3)
R = "/Volumes/Data/dev/wakeword-arion/tts"; z = np.zeros(16000, np.float32); rej = {}; keep = 0
for kind in ["pos_word", "pos_rion", "pos_ryan"]:
    for f in sorted(glob.glob(f"{R}/{kind}/vi_*.wav")):
        a = load_wav(f)
        segs, _ = m.transcribe(np.concatenate([z, a, z]), language="vi", beam_size=5, condition_on_previous_text=False, without_timestamps=True)
        t = " ".join(s.text for s in segs).lower().strip(); n = len(re.findall(r"\w+", t))
        if not (1 <= n <= 4 and len(a) / 16000 < 2.0):
            rej[f"{kind}/{os.path.basename(f)}"] = t
            os.makedirs(f"{R}/rejected", exist_ok=True); os.rename(f, f"{R}/rejected/{kind}__{os.path.basename(f)}")
        else: keep += 1
json.dump(rej, open(f"{R}/rejected_v2.json", "w"), ensure_ascii=False, indent=1)
print("kept", keep, "rejected", len(rej))
