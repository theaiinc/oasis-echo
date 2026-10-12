"""v2 features: one head for "Arion" and its variants (Arion / a ri on / ri-on / Rion / Ryan, plus "Arion ơi" and
"Hey Arion"). Reuses the v1 audio, augmentation and long negative streams; rebuilds only what changed.

feats/pos_arion2_{train,val}.npy   positives (end-aligned 16x96 windows)
feats/neg_tts2_train.npy           TTS negatives without the texts that now contain the word, plus look-alikes
feats/ev2pos_<cond>.npy + ev2pos_meta.json   held-out positives with their variant group
feats/ev2look.npy + ev2look_meta.json        held-out look-alike words (each alone, clean + 10 dB car)
feats/evstream_tts_neg_test_v2.npy           held-out dense TTS negatives (v2 rules)
"""
import os, sys, glob, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import build_features as bf
from build_features import files, voice_key, place, embed_clips, save_stream, noisy_speech_stream, OUT
from audio_aug import *
from texts import *

rng = np.random.default_rng(2026)
TTS = f"{ROOT}/tts"


def idx(p):
    return int(os.path.basename(p).rsplit("_", 1)[1][:3])


def is_vi(p):
    k = voice_key(p)
    return k.startswith("vi_") or k == "say_Linh"


def text_of(kind, p):
    i, k, vi = idx(p), voice_key(p), is_vi(p)
    if kind == "pos_word":
        return (VI_POS_WORD if vi else EN_POS_WORD)[i // 3]
    if kind == "pos_rion":
        return (VI_POS_RION if vi else EN_POS_RION)[i // 2]
    if kind == "pos_ryan":
        return (VI_POS_RYAN[i // 2] if k.startswith("vi_") else VI_POS_RYAN[i]) if vi else EN_POS_RYAN[i]
    if kind == "pos_arion":
        return VI_POS_ARION[i // (4 if k == "say_Linh" else 3)]
    if kind == "pos_hey":
        if k.startswith("vi_"): return VI_POS_HEY[i // 2]
        if k == "say_Linh": return VI_POS_HEY[i // 2]
        return EN_POS_HEY[i // 3]
    if kind == "neg":
        conf = VI_CONFUSABLE if vi else EN_CONFUSABLE
        if k == "say_Linh":
            allt = VI_CONFUSABLE + VI_SPEECH
            return allt[i] if i < len(allt) else "(speech)"
        return conf[i] if i < len(conf) else "(speech)"
    if kind == "lookalike":
        return (VI_LOOKALIKE if vi else EN_LOOKALIKE)[i]


GROUP = {}
for t in ["Arion.", "Arion!", "Arion?", "Ơ, Arion.", "Air-ee-on.", "Uh-rye-on."]: GROUP[t] = "Arion"
for t in ["A-ri-ôn.", "A ri ôn!", "Aaa ri ôn."]: GROUP[t] = "a ri on"
for t in ["Ri ôn.", "Ri-ôn!", "Ri ôn ơi.", "ri ôn", "Ree-on!", "Ree-on?"]: GROUP[t] = "ri-on"
for t in ["Rion.", "Rion!", "Rion ơi!"]: GROUP[t] = "Rion"
for t in ["Ryan.", "Ryan!", "Ryan?", "Rye-on.", "Rye-on!", "Rai-ần."]: GROUP[t] = "Ryan"


def group(kind, p):
    if kind == "pos_arion": return "Arion ơi"
    if kind == "pos_hey": return "Hey Arion"
    return GROUP[text_of(kind, p)]


def clip_start(x, rng):
    """Barely-voiced initial 'A': fade the first 120-250 ms in from near silence."""
    n = min(len(x), int(rng.uniform(0.12, 0.25) * SR))
    x = x.copy(); x[:n] *= np.linspace(rng.uniform(0.0, 0.15), 1, n) ** 2
    return x


AUGS = {"pos_word": 20, "pos_rion": 20, "pos_ryan": 20, "pos_arion": 8, "pos_hey": 6}


def build_pos(bgs):
    clips, src, kinds = [], [], []
    for kind, n in AUGS.items():
        for f in files(kind, test=False):
            u = trim(load_wav(f))
            for _ in range(n):
                a = augment_utt(u, rng)
                if kind in ("pos_word", "pos_rion") and rng.random() < 0.3:
                    a = clip_start(a, rng)
                end = bf.CLIP - int(rng.uniform(0.0, 0.35) * SR)
                snr = None if rng.random() < 0.1 else rng.uniform(-5, 22)
                clips.append(place(a, bgs.sample(bf.CLIP), end, rng, snr)); src.append(f); kinds.append((kind, f))
    E = embed_clips(clips)[:, -16:]
    uniq = sorted(set(src)); val_f = set(rng.choice(uniq, size=len(uniq) // 10, replace=False))
    val = np.array([s in val_f for s in src])
    np.save(f"{OUT}/pos_arion2_train.npy", E[~val]); np.save(f"{OUT}/pos_arion2_val.npy", E[val])
    g = np.array([group(k, f) for k, f in kinds])
    np.save(f"{OUT}/pos_arion2_train_groups.npy", g[~val]); np.save(f"{OUT}/pos_arion2_val_groups.npy", g[val])
    print("pos v2 train", (~val).sum(), "val", val.sum(), flush=True)


def build_neg(bgs):
    clips = []
    items = [(f, 2) for f in files("neg", test=False) if text_of("neg", f) not in NOT_NEGATIVE]
    items = [(f, 6 if text_of("neg", f) != "(speech)" else 2) for f, _ in items]
    items += [(f, 4) for f in files("lookalike", test=False) if text_of("lookalike", f) != "Orion."]
    for f, n in items:
        u = trim(load_wav(f))
        for _ in range(n):
            a = augment_utt(u, rng)
            end = bf.CLIP - int(rng.uniform(0.0, 0.6) * SR)
            snr = None if rng.random() < 0.1 else rng.uniform(-2, 22)
            clips.append(place(a, bgs.sample(bf.CLIP), end, rng, snr))
    E = embed_clips(clips)
    W = np.lib.stride_tricks.sliding_window_view(E, 16, axis=1).transpose(0, 1, 3, 2).reshape(-1, 16, 96)
    np.save(f"{OUT}/neg_tts2_train.npy", W)
    print("neg v2 clips", len(clips), "windows", len(W), flush=True)


def build_eval(bgs, erng):
    meta = []
    fl = []
    for kind in ["pos_word", "pos_rion", "pos_ryan", "pos_arion", "pos_hey"]:
        for f in files(kind, test=True):
            fl.append((kind, f)); meta.append({"file": f"{kind}/{os.path.basename(f)}", "group": group(kind, f),
                                               "text": text_of(kind, f), "voice": voice_key(f)})
    json.dump(meta, open(f"{OUT}/ev2pos_meta.json", "w"), ensure_ascii=False)
    for cname, snr in {"clean": None, "car10": 10, "car5": 5, "car0": 0}.items():
        if os.path.exists(f"{OUT}/ev2pos_{cname}.npy"): continue
        clips = []
        for kind, f in fl:
            u = trim(load_wav(f))
            for rep in range(2):
                a = augment_utt(u, erng, rir_p=0.5) if cname != "clean" else u
                bg = bgs.sample(4 * SR) if snr is not None else car_noise(4 * SR, erng)
                clips.append(place(a, bg, 3 * SR, erng, snr))
        np.save(f"{OUT}/ev2pos_{cname}.npy", embed_clips(clips)); print("ev2pos", cname, len(clips), flush=True)
    # look-alikes (held-out voices), each alone, clean and at 10 dB car noise
    lm, clips = [], []
    for f in files("lookalike", test=True):
        u = trim(load_wav(f))
        for snr in (None, 10):
            clips.append(place(u, car_noise(4 * SR, erng), 3 * SR, erng, snr))
            lm.append({"text": text_of("lookalike", f), "lang": "vi" if is_vi(f) else "en", "voice": voice_key(f)})
    for f in files("neg", test=True):  # v1 confusables too ("Ari ơi", "Marion ơi", "Hey Aaron", ...)
        t = text_of("neg", f)
        if t == "(speech)": continue
        u = trim(load_wav(f))
        for snr in (None, 10):
            clips.append(place(u, car_noise(4 * SR, erng), 3 * SR, erng, snr))
            lm.append({"text": t, "lang": "vi" if is_vi(f) else "en", "voice": voice_key(f)})
    np.save(f"{OUT}/ev2look.npy", embed_clips(clips)); json.dump(lm, open(f"{OUT}/ev2look_meta.json", "w"), ensure_ascii=False)
    print("ev2look", len(clips), flush=True)
    neg = [trim(load_wav(f)) for f in files("neg", test=True) if text_of("neg", f) not in NOT_NEGATIVE]
    neg += [trim(load_wav(f)) for f in files("lookalike", test=True)]
    erng.shuffle(neg)
    save_stream("evstream_tts_neg_test_v2", noisy_speech_stream(neg * 2, erng, snr_lo=5, snr_hi=25))


if __name__ == "__main__":
    stage = sys.argv[1]
    if stage == "train":
        bgs = Backgrounds("train", rng)
        if not os.path.exists(f"{OUT}/pos_arion2_val.npy"): build_pos(bgs)
        if not os.path.exists(f"{OUT}/neg_tts2_train.npy"): build_neg(bgs)
    else:
        erng = np.random.default_rng(31337)
        build_eval(Backgrounds("test", erng), erng)
    print("v2", stage, "done", flush=True)
