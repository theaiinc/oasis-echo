"""Held-out evaluation of an exported keyword head with ONNX Runtime.

usage: evaluate.py model.onnx arion|hey [thr ...]
Recall: held-out voices (never seen in training), each clip placed in 4 s of background.
False accepts / hour: held-out negative audio streams, frame scores every 80 ms, 2 s refractory.
"""
import sys, json, glob, os
import numpy as np
import onnxruntime as ort

ROOT = "/Volumes/Data/dev/wakeword-arion"; FE = f"{ROOT}/feats"
sys.path.insert(0, os.path.dirname(__file__))
from train import windows, count_fa, FRAME_S

model, kw = sys.argv[1], sys.argv[2]
PAT = int(os.environ.get("PATIENCE", "1"))
thrs = [float(t) for t in sys.argv[3:]] or [0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98]
so = ort.SessionOptions(); so.intra_op_num_threads = 4
sess = ort.InferenceSession(model, so)


def run(W):
    out = []
    for i in range(0, len(W), 8192):
        out.append(sess.run(None, {"input": np.ascontiguousarray(W[i:i + 8192], dtype=np.float32)})[0][:, 0])
    return np.concatenate(out)


res = {"model": os.path.basename(model), "recall": {}, "fa_per_hour": {}, "hours": {}}
for f in sorted(glob.glob(f"{FE}/evpos_{kw}_*.npy")):
    cond = f.split(f"evpos_{kw}_")[1][:-4]
    E = np.load(f).astype(np.float32)
    W = np.lib.stride_tricks.sliding_window_view(E, 16, axis=1).transpose(0, 1, 3, 2)
    S = run(W.reshape(-1, 16, 96)).reshape(W.shape[0], W.shape[1])
    s = np.minimum(S[:, :S.shape[1] - PAT + 1], S[:, PAT - 1:]).max(1) if PAT == 2 else S.max(1)
    res["recall"][cond] = {t: round(float((s >= t).mean()), 4) for t in thrs}
    res["recall"][cond]["n"] = int(len(s))

streams = {os.path.basename(f)[9:-4]: f for f in sorted(glob.glob(f"{FE}/evstream_*.npy"))}
streams["oww_validation_set (en, 11h)"] = f"{ROOT}/data/validation_set_features.npy"
tot_fa = {t: 0 for t in thrs}; tot_h = 0
for nm, f in streams.items():
    s = run(windows(np.load(f).astype(np.float32)))
    h = len(s) * FRAME_S / 3600
    res["hours"][nm] = round(h, 2); tot_h += h
    res["fa_per_hour"][nm] = {}
    for t in thrs:
        n = count_fa(s, t, patience=PAT); tot_fa[t] += n
        res["fa_per_hour"][nm][t] = round(n / h, 3)
res["fa_per_hour"]["ALL"] = {t: round(tot_fa[t] / tot_h, 3) for t in thrs}
res["hours"]["ALL"] = round(tot_h, 2)
print(json.dumps(res, indent=1, ensure_ascii=False))
res["patience"] = PAT
json.dump(res, open(model[:-5] + f"_eval_p{PAT}.json", "w"), indent=1, ensure_ascii=False)
