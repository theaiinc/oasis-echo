"""Train an openWakeWord-style keyword head (16x96 embeddings -> score) and export ONNX.

usage: train.py arion|hey [--hidden 32] [--steps 30000] [--tag name]
"""
import os, sys, json, argparse, time
import numpy as np
import torch, torch.nn as nn

ROOT = "/Volumes/Data/dev/wakeword-arion"
FE = f"{ROOT}/feats"
torch.set_num_threads(4)
FRAME_S = 0.08


def windows(stream):
    return np.lib.stride_tricks.sliding_window_view(stream, 16, axis=0).transpose(0, 2, 1)  # (F-15,16,96) view


class Head(nn.Module):
    def __init__(self, hidden=32, drop=0.0):
        super().__init__()
        self.net = nn.Sequential(
            nn.Flatten(), nn.Linear(16 * 96, hidden), nn.LayerNorm(hidden), nn.ReLU(), nn.Dropout(drop),
            nn.Linear(hidden, hidden), nn.LayerNorm(hidden), nn.ReLU(), nn.Dropout(drop),
            nn.Linear(hidden, 1), nn.Sigmoid())

    def forward(self, x):
        return self.net(x)


def score(model, W, bs=8192):
    model.eval(); out = []
    with torch.no_grad():
        for i in range(0, len(W), bs):
            out.append(model(torch.from_numpy(np.ascontiguousarray(W[i:i + bs], dtype=np.float32))).numpy()[:, 0])
    model.train()
    return np.concatenate(out) if out else np.zeros(0)


def count_fa(scores, thr, refractory_frames=25, patience=1):
    """Detections on a frame-score stream: score >= thr for `patience` frames in a row, then a 2 s refractory
    period (the app's WakeWordDetector rules)."""
    hit = scores >= thr
    if patience > 1:
        run = np.convolve(hit.astype(np.int32), np.ones(patience, np.int32), "full")[: len(hit)]
        hit = run >= patience
    n, last = 0, -10**9
    for i in np.flatnonzero(hit):
        if i - last >= refractory_frames:
            n += 1; last = i
    return n


def acav():
    mm = np.memmap(f"{ROOT}/data/acav_part.npy", dtype=np.float16, mode="r", offset=128)
    n = len(mm) // (16 * 96)
    return mm[: n * 16 * 96].reshape(n, 16, 96)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kw"); ap.add_argument("--hidden", type=int, default=32)
    ap.add_argument("--steps", type=int, default=30000); ap.add_argument("--tag", default="")
    ap.add_argument("--max_neg_w", type=float, default=30.0)
    ap.add_argument("--drop", type=float, default=0.3); ap.add_argument("--noise", type=float, default=0.1)
    ap.add_argument("--wd", type=float, default=1e-2)
    a = ap.parse_args()
    tag = a.tag or f"{a.kw}_h{a.hidden}"
    rng = np.random.default_rng(0); torch.manual_seed(0)

    P = np.load(f"{FE}/pos_{a.kw}_train.npy").astype(np.float32)
    Pv = np.load(f"{FE}/pos_{a.kw}_val.npy").astype(np.float32)
    NT = np.load(f"{FE}/neg_tts_train.npy", mmap_mode="r")
    # the other keyword's positives are not used as negatives (both heads start the same assistant)
    streams, val_streams = {}, {}
    for nm in ["fleurs_train", "car_train", "music_train", "musan_train"]:
        s = np.load(f"{FE}/stream_{nm}.npy")
        cut = int(len(s) * 0.85)
        streams[nm] = windows(s[:cut]); val_streams[nm] = s[cut:]
    import glob
    vi = [np.load(f) for f in sorted(glob.glob(f"{FE}/stream_yt_*.npy")) + sorted(glob.glob(f"{FE}/stream_vlsp_*.npy"))]
    if vi:
        streams["vi_speech"] = windows(np.concatenate(vi))
    val_streams["fleurs_val"] = np.load(f"{FE}/valstream_fleurs_val.npy")
    if os.path.exists(f"{FE}/valstream_vlsp_00004.npy"):
        val_streams["vlsp_val"] = np.load(f"{FE}/valstream_vlsp_00004.npy")
    A = acav(); nA = len(A); a_val = np.arange(nA - 60000, nA); a_tr = nA - 60000
    print(f"pos {len(P)} posval {len(Pv)} negtts {len(NT)} acav {nA}", {k: len(v) for k, v in streams.items()}, flush=True)

    model = Head(a.hidden, a.drop)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=a.wd)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=a.steps, pct_start=0.1)
    bce = nn.BCELoss(reduction="none")
    hard = np.zeros((0, 16, 96), np.float32)
    s_names = list(streams)

    def batch():
        xs = [P[rng.integers(len(P), size=192)]]
        xs.append(np.asarray(NT[np.sort(rng.integers(len(NT), size=160))], np.float32))
        for nm in s_names:
            w = streams[nm]; k = {"fleurs_train": 96, "vi_speech": 256}.get(nm, 48)
            xs.append(np.asarray(w[rng.integers(len(w), size=k)], np.float32))
        xs.append(np.asarray(A[np.sort(rng.integers(a_tr, size=256))], np.float32))
        if len(hard):
            xs.append(hard[rng.integers(len(hard), size=128)])
        X = np.concatenate(xs)
        y = np.zeros(len(X), np.float32); y[:192] = 1
        if a.noise:
            X = X + np.random.default_rng(rng.integers(1 << 30)).normal(0, a.noise, X.shape).astype(np.float32) * X.std()
        return torch.from_numpy(X), torch.from_numpy(y)

    def mine():
        cands = [np.asarray(NT[np.sort(rng.choice(len(NT), size=min(60000, len(NT)), replace=False))], np.float32),
                 np.asarray(A[np.sort(rng.choice(a_tr, size=150000, replace=False))], np.float32)]
        for nm in s_names:
            w = streams[nm]
            k = 150000 if nm == "vi_speech" else 40000
            cands.append(np.asarray(w[np.sort(rng.choice(len(w), size=min(k, len(w)), replace=False))], np.float32))
        C = np.concatenate(cands)
        s = score(model, C)
        top = np.argsort(-s)[:8000]
        return C[top], float(s[top[-1]])

    def validate():
        ps = score(model, Pv)
        vs = {nm: score(model, windows(s)) for nm, s in val_streams.items()}
        av = score(model, np.asarray(A[a_val], np.float32))
        hours = sum(len(v) for v in vs.values()) * FRAME_S / 3600 + len(a_val) * FRAME_S / 3600
        res = {}
        for thr in (0.3, 0.5, 0.7, 0.8, 0.9, 0.95):
            fa = sum(count_fa(v, thr) for v in vs.values()) + count_fa(av, thr)
            res[thr] = (round(float((ps >= thr).mean()), 4), round(fa / hours, 3))
        print("   val FA@0.9 by source:", {k: count_fa(v, 0.9) for k, v in vs.items()}, flush=True)
        return res, hours

    t0 = time.time(); best = None
    for step in range(1, a.steps + 1):
        X, y = batch()
        p = model(X)[:, 0].clamp(1e-6, 1 - 1e-6)
        frac = min(1.0, step / (0.6 * a.steps))
        wneg = 1 + (a.max_neg_w - 1) * frac
        w = torch.where(y > 0, torch.ones_like(y), torch.full_like(y, wneg))
        loss = (bce(p, y) * w).sum() / w.sum()
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        if step % 3000 == 0 and step >= 6000:
            hard, hthr = mine()
            print(f"  mined {len(hard)} hard negatives (min score {hthr:.3f})", flush=True)
        if step % 2500 == 0 or step == a.steps:
            res, hours = validate()
            # selection metric: recall at the lowest threshold with val FA/h <= 0.3
            ok = [(r, thr) for thr, (r, fa) in res.items() if fa <= 0.3]
            m = max(ok) if ok else (0, None)
            print(f"step {step} loss {loss.item():.4f} wneg {wneg:.1f} t={time.time()-t0:.0f}s val({hours:.1f}h) {res} sel={m}", flush=True)
            if step >= a.steps * 0.5 and (best is None or m[0] >= best[0]):
                best = (m[0], step); torch.save(model.state_dict(), f"{ROOT}/ckpt_{tag}.pt")
    print("best", best)
    model.load_state_dict(torch.load(f"{ROOT}/ckpt_{tag}.pt"))
    model.eval()
    os.makedirs(f"{ROOT}/out", exist_ok=True)
    onnx_path = f"{ROOT}/out/{tag}.onnx"
    torch.onnx.export(model, torch.zeros(1, 16, 96), onnx_path, input_names=["input"], output_names=["output"],
                      dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}}, opset_version=13, dynamo=False)
    print("exported", onnx_path, os.path.getsize(onnx_path))


if __name__ == "__main__":
    main()
