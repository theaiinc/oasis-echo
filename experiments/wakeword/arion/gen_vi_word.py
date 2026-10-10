import os, sys, csv, numpy as np, soundfile as sf
sys.path.insert(0, os.path.dirname(__file__)); from texts import VI_POS_WORD
from vieneu import Vieneu
OUT = "/Volumes/Data/dev/wakeword-arion/tts/pos_word"; os.makedirs(OUT, exist_ok=True)
tts = Vieneu(mode="v3turbo", onnx_dir="models/turbo/onnx_int8", precision="int8", backbone_repo="models/turbo")
for voice in [v[1] for v in tts.list_preset_voices()]:
    i = 0
    for t in VI_POS_WORD:
        for temp in (0.6, 0.85, 1.05):
            p = f"{OUT}/vi_{voice.replace(' ','_')}_{i:03d}.wav"; i += 1
            if os.path.exists(p): continue
            a = np.asarray(tts.infer(t, voice=voice, temperature=temp, apply_watermark=False)).squeeze()
            sf.write(p, a, tts.sample_rate)
    print("done", voice, flush=True)
