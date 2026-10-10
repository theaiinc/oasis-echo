"""Evaluate the single "Arion" head: recall per variant group, FA/h, look-alike rates, for several thresholds.

usage: evaluate_v2.py model.onnx  (env PATIENCE=1|2)
"""
import sys, os, json, glob, collections
import numpy as np, onnxruntime as ort
sys.path.insert(0, os.path.dirname(__file__))
from train import windows, count_fa, FRAME_S
ROOT = "/Volumes/Data/dev/wakeword-arion"; FE = f"{ROOT}/feats"
model = sys.argv[1]; PAT = int(os.environ.get("PATIENCE", "1"))
THR = [float(t) for t in os.environ.get("THRS", "0.05,0.1,0.2,0.3,0.5,0.7").split(",")]
so = ort.SessionOptions(); so.intra_op_num_threads = 4
# "a.onnx+b.onnx" evaluates an OR of heads: each head applies the patience rule on its own scores, a detection
# from any head counts. Equivalent here to a per-frame max of the patience-filtered scores.
sessions = [ort.InferenceSession(m, so) for m in model.split("+")]


def run_raw(W):
    return np.stack([np.concatenate([s.run(None, {"input": np.ascontiguousarray(W[i:i + 8192], dtype=np.float32)})[0][:, 0]
                                     for i in range(0, len(W), 8192)]) for s in sessions])


def pat(S):  # S (..., frames): min over the last PAT frames
    if PAT == 2:
        S = np.concatenate([np.zeros(S.shape[:-1] + (1,), S.dtype), np.minimum(S[..., :-1], S[..., 1:])], -1)
    return S


def run(W):  # patience-filtered, OR over heads
    return pat(run_raw(W)).max(0)


def clip_max(E):
    W = np.lib.stride_tricks.sliding_window_view(E.astype(np.float32), 16, axis=1).transpose(0, 1, 3, 2)
    S = pat(run_raw(W.reshape(-1, 16, 96)).reshape(len(sessions), W.shape[0], W.shape[1])).max(0)
    return S.max(1)


res = {"model": os.path.basename(model), "patience": PAT, "thresholds": THR, "recall": {}, "fa_per_hour": {}, "hours": {}, "lookalike": {}}
meta = json.load(open(f"{FE}/ev2pos_meta.json"))
groups = [m["group"] for m in meta for _ in range(2)]
for cond in ["clean", "car10", "car5", "car0"]:
    s = clip_max(np.load(f"{FE}/ev2pos_{cond}.npy"))
    by = collections.defaultdict(list)
    for g, v in zip(groups, s): by[g].append(v); by["ALL"].append(v)
    res["recall"][cond] = {g: {"n": len(v), **{str(t): round(float(np.mean(np.array(v) >= t)), 4) for t in THR}} for g, v in by.items()}

streams = {os.path.basename(f)[9:-4]: f for f in sorted(glob.glob(f"{FE}/evstream_*.npy")) if not f.endswith("tts_neg_test.npy")}
streams["oww_validation_set_en"] = f"{ROOT}/data/validation_set_features.npy"
tot = collections.Counter(); H = 0
for nm, f in streams.items():
    s = run(windows(np.load(f).astype(np.float32))); h = len(s) * FRAME_S / 3600
    res["hours"][nm] = round(h, 2)
    res["fa_per_hour"][nm] = {str(t): round(count_fa(s, t) / h, 3) for t in THR}
    if nm != "tts_neg_test_v2":
        H += h
        for t in THR: tot[t] += count_fa(s, t)
res["hours"]["natural_total"] = round(H, 2)
res["fa_per_hour"]["natural_total"] = {str(t): round(tot[t] / H, 3) for t in THR}

lm = json.load(open(f"{FE}/ev2look_meta.json"))
s = clip_max(np.load(f"{FE}/ev2look.npy"))
by = collections.defaultdict(list)
for m, v in zip(lm, s): by[f'{m["lang"]}: {m["text"]}'].append(v)
res["lookalike"] = {k: {"n": len(v), **{str(t): round(float(np.mean(np.array(v) >= t)), 3) for t in THR}} for k, v in sorted(by.items())}
out = "+".join(os.path.basename(m)[:-5] for m in model.split("+"))
out = f"{ROOT}/out/{out}_eval2_p{PAT}.json"
json.dump(res, open(out, "w"), indent=1, ensure_ascii=False)
print("wrote", out)
