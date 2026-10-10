import os, sys, numpy as np, soundfile as sf
sys.path.insert(0, os.path.dirname(__file__)); from texts import VI_POS_RION, VI_LOOKALIKE
from vieneu import Vieneu
R = "/Volumes/Data/dev/wakeword-arion/tts"
tts = Vieneu(mode="v3turbo", onnx_dir="models/turbo/onnx_int8", precision="int8", backbone_repo="models/turbo")
def gen(d, t, voice, temp, i):
    p = f"{R}/{d}/vi_{voice.replace(' ','_')}_{i:03d}.wav"
    if os.path.exists(p): return
    os.makedirs(os.path.dirname(p), exist_ok=True)
    a = np.asarray(tts.infer(t, voice=voice, temperature=temp, apply_watermark=False)).squeeze(); sf.write(p, a, tts.sample_rate)
for voice in [v[1] for v in tts.list_preset_voices()]:
    i = 0
    for t in VI_POS_RION:
        for temp in (0.7, 1.0): gen("pos_rion", t, voice, temp, i); i += 1
    for i, t in enumerate(VI_LOOKALIKE): gen("lookalike", t, voice, 0.85, i)
    print("done", voice, flush=True)
