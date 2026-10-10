"""Build openWakeWord embedding features for "Arion ơi" / "Hey Arion".

Outputs (float16) in /Volumes/Data/dev/wakeword-arion/feats:
  train:  pos_{arion,hey}_{train,val}.npy  (N,16,96)   end-aligned windows of augmented positives
          neg_tts_train.npy                 (N,16,96)   windows from augmented negative TTS (incl. confusables)
          stream_*.npy                      (F,96)      embedding streams of long negative audio
  eval:   evpos_{arion,hey}_<cond>.npy      (N,F,96)    held-out-voice positives in 4 s clips
          evstream_*.npy                    (F,96)      held-out negative audio streams
"""
import os, sys, glob, json, unicodedata, time
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from audio_aug import *
from texts import VI_CONFUSABLE, EN_CONFUSABLE
from openwakeword.utils import AudioFeatures

OWW = os.path.expanduser("~/oasis-echo/experiments/wakeword/models")
F = AudioFeatures(f"{OWW}/melspectrogram.onnx", f"{OWW}/embedding_model.onnx", ncpu=4)
OUT = f"{ROOT}/feats"; os.makedirs(OUT, exist_ok=True)
TTS = f"{ROOT}/tts"
NFC = lambda s: unicodedata.normalize("NFC", s)
TEST_VOICES = {NFC(v) for v in [
    "vi_Mỹ_Duyên", "vi_Đức_Trí", "vi_Ngọc_Trân", "vi_Quốc_Tuấn", "vi_Đoan_Trang", "say_Linh",
    "en_af_bella", "en_am_michael", "en_bf_emma", "en_bm_george", "say_Samantha", "say_Daniel", "say_Karen", "say_Rishi"]}
CLIP = 3 * SR
rng = np.random.default_rng(1234)


def voice_key(p):
    return NFC(os.path.basename(p)).rsplit("_", 1)[0]


def is_confusable(p):
    k = voice_key(p); idx = int(os.path.basename(p).rsplit("_", 1)[1][:3])
    return idx < (len(VI_CONFUSABLE) if k.startswith("vi_") or k == "say_Linh" else len(EN_CONFUSABLE))


def files(kind, test):
    fs = sorted(glob.glob(f"{TTS}/{kind}/*.wav"))
    return [f for f in fs if (voice_key(f) in TEST_VOICES) == test]


def embed_clips(clips):
    X = np.stack(clips)
    out = []
    for i in range(0, len(X), 512):
        out.append(F.embed_clips(X[i:i + 512], batch_size=128, ncpu=4).astype(np.float16))
    return np.concatenate(out)


def embed_long(x16):
    """Embedding stream (F,96) of a long int16 signal: melspec in 60 s pieces, then 76-frame windows, hop 8."""
    mels = [F._get_melspectrogram(x16[s:s + 60 * SR]) for s in range(0, len(x16), 60 * SR) if len(x16[s:s + 60 * SR]) >= 1600]
    M = np.concatenate(mels).astype(np.float32)
    idx = np.arange(0, M.shape[0] - 76 + 1, 8)
    out = []
    for i in range(0, len(idx), 2048):
        b = np.stack([M[j:j + 76] for j in idx[i:i + 2048]])[..., None]
        out.append(np.asarray(F.embedding_model_predict(b)).reshape(len(b), 96).astype(np.float16))
    return np.concatenate(out)


def place(utt, bg, end_pos, rng, snr):
    n = len(bg)
    if len(utt) > end_pos:
        utt = utt[-end_pos:]
    y = np.zeros(n, np.float32); y[end_pos - len(utt):end_pos] = utt
    x = mix(y, bg, snr) if snr is not None else y + 1e-4 * bg
    return to_int16(x, rng)


def build_pos(kind, augs, bgs):
    fs = files(kind, test=False)
    clips = []
    for f in fs:
        u = trim(load_wav(f))
        for _ in range(augs):
            a = augment_utt(u, rng)
            end = CLIP - int(rng.uniform(0.0, 0.25) * SR)
            snr = None if rng.random() < 0.1 else rng.uniform(-2, 22)
            clips.append(place(a, bgs.sample(CLIP), end, rng, snr))
    E = embed_clips(clips)[:, -16:]
    # clip-level validation split (whole source file held out across all its augmentations)
    src = np.repeat(np.arange(len(fs)), augs)
    val = np.isin(src, rng.choice(len(fs), size=len(fs) // 10, replace=False))
    np.save(f"{OUT}/pos_{kind[4:]}_train.npy", E[~val]); np.save(f"{OUT}/pos_{kind[4:]}_val.npy", E[val])
    print(kind, "train", (~val).sum(), "val", val.sum(), flush=True)


def build_neg_tts(bgs):
    fs = files("neg", test=False)
    clips = []
    for f in fs:
        u = trim(load_wav(f))
        for _ in range(6 if is_confusable(f) else 2):
            a = augment_utt(u, rng)
            end = CLIP - int(rng.uniform(0.0, 0.6) * SR)
            snr = None if rng.random() < 0.1 else rng.uniform(-2, 22)
            clips.append(place(a, bgs.sample(CLIP), end, rng, snr))
    E = embed_clips(clips)
    W = np.lib.stride_tricks.sliding_window_view(E, 16, axis=1).transpose(0, 1, 3, 2).reshape(-1, 16, 96)
    np.save(f"{OUT}/neg_tts_train.npy", W)
    print("neg_tts windows", len(W), flush=True)


def noisy_speech_stream(arrs, rng, snr_lo=0, snr_hi=25, gap=(0.2, 1.5), clean_p=0.2):
    parts = []
    for a in arrs:
        a = augment_utt(a, rng, rir_p=0.5)
        parts.append(a); parts.append(np.zeros(int(rng.uniform(*gap) * SR), np.float32))
    x = np.concatenate(parts)
    out = np.empty_like(x)
    seg = 20 * SR
    for s in range(0, len(x), seg):
        y = x[s:s + seg]
        if rng.random() < clean_p:
            z = y + 0.003 * car_noise(len(y), rng) * (np.std(y) + 1e-3)
        else:
            z = mix(y, car_noise(len(y), rng), rng.uniform(snr_lo, snr_hi))
        out[s:s + seg] = z / (np.abs(z).max() + 1e-9) * rng.uniform(0.1, 0.8)
    return to_int16(out, peak=0.9 * np.abs(out).max() / (np.abs(out).max() + 1e-9))


def done(name):
    return os.path.exists(f"{OUT}/{name}.npy")


def save_speech_stream(name, parquet, rng, limit=None, **kw):
    """Chunked: 200 utterances at a time to keep memory low."""
    if done(name): return
    es, buf, secs = [], [], 0
    for a in parquet_audio(parquet, limit=limit):
        buf.append(a)
        if len(buf) == 200:
            x = noisy_speech_stream(buf, rng, **kw); secs += len(x) / SR; es.append(embed_long(x)); buf = []
    if buf:
        x = noisy_speech_stream(buf, rng, **kw); secs += len(x) / SR; es.append(embed_long(x))
    e = np.concatenate(es); np.save(f"{OUT}/{name}.npy", e)
    print(name, f"{secs/3600:.2f} h", e.shape, flush=True)


def save_stream(name, x16):
    if done(name): return
    e = embed_long(x16)
    np.save(f"{OUT}/{name}.npy", e)
    print(name, f"{len(x16)/SR/3600:.2f} h", e.shape, flush=True)


def noise_stream(gen, hours, rng):
    parts = []
    tot = 0
    while tot < hours * 3600 * SR:
        n = int(rng.uniform(10, 40) * SR)
        x = gen(n)
        parts.append(x / (np.abs(x).max() + 1e-9) * rng.uniform(0.02, 0.8)); tot += n
    return to_int16(np.concatenate(parts), peak=0.8)


def build_eval_pos(kind, bgs):
    fs = files(kind, test=True)
    conds = {"clean": None, "car10": 10, "car5": 5, "car0": 0}
    meta = {"files": [os.path.basename(f) for f in fs]}
    for cname, snr in conds.items():
        clips = []
        for f in fs:
            u = trim(load_wav(f))
            for rep in range(2):
                a = augment_utt(u, rng, rir_p=0.5) if cname != "clean" else u
                end = 3 * SR
                n = 4 * SR
                bg = bgs.sample(n) if snr is not None else car_noise(n, rng)
                clips.append(place(a, bg, end, rng, snr))
        E = embed_clips(clips)
        np.save(f"{OUT}/evpos_{kind[4:]}_{cname}.npy", E)
        print("eval", kind, cname, E.shape, flush=True)
    json.dump(meta, open(f"{OUT}/evpos_{kind[4:]}_files.json", "w"), ensure_ascii=False)


def main(stage):
    t0 = time.time()
    if stage in ("train", "all"):
        bgs = Backgrounds("train", rng)
        if not done("pos_arion_val"): build_pos("pos_arion", 30, bgs)
        if not done("pos_hey_val"): build_pos("pos_hey", 16, bgs)
        if not done("neg_tts_train"): build_neg_tts(bgs)
        # long negative streams
        save_speech_stream("stream_fleurs_train", f"{ROOT}/data/fleurs_vi_train.parquet", rng)
        save_stream("stream_car_train", noise_stream(lambda n: car_noise(n, rng), 1.5, rng))
        save_stream("stream_music_train", noise_stream(lambda n: bgs.music.crop(n, rng) + rng.uniform(0, 1) * car_noise(n, rng), 1.0, rng))
        save_stream("stream_musan_train", noise_stream(lambda n: bgs.musan.crop(n, rng) + rng.uniform(0, 1) * car_noise(n, rng), 1.0, rng))
        save_speech_stream("valstream_fleurs_val", f"{ROOT}/data/fleurs_vi_validation.parquet", np.random.default_rng(7))
        print("train stage done", time.time() - t0, flush=True)
    if stage in ("eval", "all"):
        erng = np.random.default_rng(999)
        bgs = Backgrounds("test", erng)
        if not done("evpos_arion_car0"): build_eval_pos("pos_arion", bgs)
        if not done("evpos_hey_car0"): build_eval_pos("pos_hey", bgs)
        # real Vietnamese read speech: clean-ish (car noise far below) and with car noise at 5-20 dB SNR
        save_speech_stream("evstream_fleurs_test_clean", f"{ROOT}/data/fleurs_vi_test.parquet", erng, clean_p=1.0)
        save_speech_stream("evstream_fleurs_test_car", f"{ROOT}/data/fleurs_vi_test.parquet", erng, snr_lo=5, snr_hi=20, clean_p=0.0)
        # held-out-voice TTS negatives (in-car speech + confusables like "anh ơi", "Arion" without "ơi")
        neg = [trim(load_wav(f)) for f in files("neg", test=True)]
        save_stream("evstream_tts_neg_test", noisy_speech_stream(neg * 3, erng, snr_lo=5, snr_hi=25))
        save_stream("evstream_car_test", noise_stream(lambda n: car_noise(n, erng), 2.0, erng))
        save_stream("evstream_music_test", noise_stream(lambda n: bgs.music.crop(n, erng) + erng.uniform(0, 0.7) * car_noise(n, erng), 2.0, erng))
        save_stream("evstream_musan_test", noise_stream(lambda n: bgs.musan.crop(n, erng), 0.5, erng))
        print("eval stage done", time.time() - t0, flush=True)




def more():
    """Extra real Vietnamese speech (YouTube ASR corpus, VLSP2020 VinAI) — negatives the first model lacked."""
    import glob as g
    r = np.random.default_rng(4321)
    for f in sorted(g.glob(f"{ROOT}/data/yt_train-*.parquet")):
        save_speech_stream("stream_yt_" + os.path.basename(f)[9:14], f, r)
    for i in ("00000", "00001", "00002", "00003"):
        save_speech_stream(f"stream_vlsp_{i}", f"{ROOT}/data/vlsp_{i}.parquet", r)
    save_speech_stream("valstream_vlsp_00004", f"{ROOT}/data/vlsp_00004.parquet", np.random.default_rng(8))
    er = np.random.default_rng(999)
    yt = g.glob(f"{ROOT}/data/yt_test-*.parquet")[0]
    save_speech_stream("evstream_yt_test_clean", yt, er, clean_p=1.0)
    save_speech_stream("evstream_yt_test_car", yt, er, snr_lo=5, snr_hi=20, clean_p=0.0)
    print("more done", flush=True)


if __name__ == "__main__":
    more() if sys.argv[1:] == ["more"] else main(sys.argv[1] if len(sys.argv) > 1 else "all")
