# Run with /Volumes/Data/dev/vieneu/venv (cwd /Volumes/Data/dev/vieneu).
import os, sys, random, csv, numpy as np, soundfile as sf
sys.path.insert(0, os.path.dirname(__file__))
from texts import *
from vieneu import Vieneu
OUT = "/Volumes/Data/dev/wakeword-arion/tts"
os.makedirs(OUT, exist_ok=True)
tts = Vieneu(mode="v3turbo", onnx_dir="models/turbo/onnx_int8", precision="int8", backbone_repo="models/turbo")
SR = tts.sample_rate
voices = [v[1] for v in tts.list_preset_voices()]
rng = random.Random(0)
meta = open(os.path.join(OUT, "meta_vi.csv"), "a", newline="")
w = csv.writer(meta)
def gen(kind, text, voice, temp, idx):
    fn = f"{kind}/vi_{voice.replace(' ','_')}_{idx:03d}.wav"
    p = os.path.join(OUT, fn)
    if os.path.exists(p): return
    os.makedirs(os.path.dirname(p), exist_ok=True)
    try:
        a = np.asarray(tts.infer(text, voice=voice, temperature=temp, apply_watermark=False)).squeeze()
    except Exception as e:
        print("ERR", voice, text, e, flush=True); return
    sf.write(p, a, SR); w.writerow([fn, kind, "vi", voice, text, temp]); meta.flush()
for vi, voice in enumerate(voices):
    i = 0
    for t in VI_POS_ARION:
        for temp in (0.6, 0.85, 1.05):
            gen("pos_arion", t, voice, temp, i); i += 1
    i = 0
    for t in VI_POS_HEY:
        for temp in (0.7, 1.0):
            gen("pos_hey", t, voice, temp, i); i += 1
    i = 0
    for t in VI_CONFUSABLE:
        gen("neg", t, voice, rng.choice((0.7, 0.9, 1.05)), i); i += 1
    sents = rng.sample(VI_SPEECH, 30)
    for t in sents:
        gen("neg", t, voice, rng.choice((0.7, 0.9, 1.05)), i); i += 1
    print("done voice", vi, voice, flush=True)
