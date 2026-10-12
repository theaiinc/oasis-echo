"""Per-phrase false-accept rate on held-out-voice negatives (each clip alone in 3 s of light car noise)."""
import sys, os, glob, json, collections
import numpy as np, onnxruntime as ort
sys.path.insert(0, os.path.dirname(__file__))
import build_features as bf
from audio_aug import *
from texts import VI_CONFUSABLE, EN_CONFUSABLE, VI_SPEECH, EN_SPEECH
cache = f"{ROOT}/feats/evconf.npz"
fs = bf.files("neg", test=True)
if not os.path.exists(cache):
    rng = np.random.default_rng(5); clips = []
    for f in fs:
        u = trim(load_wav(f))
        for snr in (None, 10):
            clips.append(bf.place(u, car_noise(4 * SR, rng), 3 * SR, rng, snr))
    np.savez(cache, E=bf.embed_clips(clips))
E = np.load(cache)["E"].astype(np.float32)
W = np.lib.stride_tricks.sliding_window_view(E, 16, axis=1).transpose(0, 1, 3, 2)
thr = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
for m in sys.argv[1].split(","):
    sess = ort.InferenceSession(m)
    s = sess.run(None, {"input": np.ascontiguousarray(W.reshape(-1, 16, 96))})[0][:, 0].reshape(W.shape[0], W.shape[1]).max(1)
    def text(f):
        k = bf.voice_key(f); i = int(os.path.basename(f).rsplit("_", 1)[1][:3])
        vi = k.startswith("vi_") or k == "say_Linh"
        conf = VI_CONFUSABLE if vi else EN_CONFUSABLE
        return conf[i] if i < len(conf) else "(ordinary speech)"
    agg = collections.defaultdict(list)
    for j, f in enumerate(fs):
        agg[text(f)] += [s[2 * j], s[2 * j + 1]]
    print(os.path.basename(m), "clips", len(s), "accepted", int((s >= thr).sum()))
    for t, v in sorted(agg.items(), key=lambda kv: -np.mean(np.array(kv[1]) >= thr)):
        r = np.mean(np.array(v) >= thr)
        if r > 0: print(f"  {r:.2f}  ({len(v)})  {t}")
