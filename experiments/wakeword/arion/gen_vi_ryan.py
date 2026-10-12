import os, sys, numpy as np, soundfile as sf
sys.path.insert(0, os.path.dirname(__file__)); from texts import VI_POS_RYAN
from vieneu import Vieneu
R = "/Volumes/Data/dev/wakeword-arion/tts/pos_ryan"; os.makedirs(R, exist_ok=True)
tts = Vieneu(mode="v3turbo", onnx_dir="models/turbo/onnx_int8", precision="int8", backbone_repo="models/turbo")
for voice in [v[1] for v in tts.list_preset_voices()]:
    for i, t in enumerate(VI_POS_RYAN):
        for j, temp in enumerate((0.7, 1.0)):
            p = f"{R}/vi_{voice.replace(' ','_')}_{2*i+j:03d}.wav"
            if not os.path.exists(p):
                sf.write(p, np.asarray(tts.infer(t, voice=voice, temperature=temp, apply_watermark=False)).squeeze(), tts.sample_rate)
print("done")
