#!/usr/bin/env python3
"""
Train OpenWakeWord verifier on "Hey Echo" + "Echo Echo".

Strategy:
- Clean state per clip (reset preprocessor between clips, skip warmup).
- Strong regularization to avoid overfitting to room noise.
- VAD-trim user recordings to keep only voiced segments.
"""

import logging
import os
import subprocess
import sys

import numpy as np
from sklearn.preprocessing import FunctionTransformer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("train")

EXPERIMENT_DIR = os.path.dirname(os.path.abspath(__file__))
POS_DIR = os.path.join(EXPERIMENT_DIR, "recordings", "wake_phrases")
NEG_DIR = os.path.join(EXPERIMENT_DIR, "recordings", "other_speech")
MODEL_DIR = os.path.join(EXPERIMENT_DIR, "models")
os.makedirs(POS_DIR, exist_ok=True)
os.makedirs(NEG_DIR, exist_ok=True)
os.makedirs(MODEL_DIR, exist_ok=True)

SR = 16000
POSITIVE_PHRASES = ["Hey Echo", "Echo Echo"]

VOICES = ["Samantha", "Alex", "Victoria", "Fred", "Daniel", "Moira", "Karen", "Fiona"]
RATES = ["180", "200", "220"]

NEGATIVE_PHRASES = [
    "hello world", "what is the weather today", "open the pod bay doors",
    "the quick brown fox jumps over the lazy dog", "set a timer for ten minutes",
    "play some music", "how are you doing today", "tell me a joke",
    "what time is it", "navigate to the nearest coffee shop",
    "good morning", "thank you very much", "please remind me to buy groceries",
    "that was a great movie", "can you help me with this", "stop that right now",
    "where is my phone", "call me an uber", "turn off the lights",
    "echo location", "echo chamber", "echo park", "echo dot", "echo sounding",
    "i hear an echo", "the echo is gone",
    "hey siri", "hey google", "hey alexa", "hey cortana", "okay google",
    "hey jarvis", "hey computer", "hey boss",
]


def say_wav(text, path, voice="Samantha", rate="200"):
    aiff = path.replace(".wav", ".aiff")
    try:
        subprocess.run(["say", "-v", voice, "-r", rate, "-o", aiff, text], capture_output=True, timeout=10)
        subprocess.run(["ffmpeg", "-y", "-i", aiff, "-ar", str(SR), "-ac", "1", "-sample_fmt", "s16", path], capture_output=True, timeout=10)
        os.remove(aiff)
        return os.path.getsize(path) > 1000
    except Exception:
        return False


def record_noise(duration=3, path=""):
    if not path:
        path = os.path.join(NEG_DIR, f"silence_{np.random.randint(1000)}.wav")
    try:
        subprocess.run(["ffmpeg", "-f", "avfoundation", "-i", ":0", "-t", str(duration),
                       "-ar", str(SR), "-ac", "1", "-sample_fmt", "s16", "-y", path], capture_output=True, timeout=duration + 5)
        return os.path.getsize(path) > 500 and os.path.exists(path)
    except Exception:
        return False


def generate_tts_positives():
    count = 0
    for phrase in POSITIVE_PHRASES:
        slug = phrase.lower().replace(" ", "_")
        d = os.path.join(POS_DIR, slug)
        os.makedirs(d, exist_ok=True)
        for v in VOICES:
            for r in RATES:
                p = os.path.join(d, f"{slug}_{v}_{r}.wav")
                if not os.path.exists(p) and say_wav(phrase, p, voice=v, rate=r):
                    count += 1
                elif os.path.exists(p):
                    count += 1
    return count


def generate_tts_negatives():
    count = 0
    for i, phrase in enumerate(NEGATIVE_PHRASES):
        v = VOICES[i % len(VOICES)]
        r = RATES[i % len(RATES)]
        for j in range(2):
            p = os.path.join(NEG_DIR, f"neg_{i:02d}_{j}.wav")
            if not os.path.exists(p) and say_wav(phrase, p, voice=v, rate=r):
                count += 1
            elif os.path.exists(p):
                count += 1
    for k in range(5):
        p = os.path.join(NEG_DIR, f"silence_{k}.wav")
        if not os.path.exists(p):
            log.info(f"  Recording ambient noise {k+1}/5...")
            record_noise(duration=3, path=p)
            if os.path.exists(p):
                count += 1
        else:
            count += 1
    return count


def load_audio(path):
    """Load WAV, return int16 array."""
    import scipy.io.wavfile as wav
    sr, dat = wav.read(path)
    if sr != SR:
        log.warning(f"  Resampling {os.path.basename(path)} from {sr} to {SR}")
        import scipy.signal as sig
        ratio = SR / sr
        new_len = int(len(dat) * ratio)
        dat = sig.resample(dat, new_len).astype(np.int16)
    return dat.astype(np.int16)


def extract_features_per_clip(oww, base_model, path):
    """
    Extract features from one clip with clean preprocessor state.
    Prepends 20480 zeros (16 chunks) for warm-up, then skips those.
    Returns (N_frames, 16, 96) array.
    """
    oww.preprocessor.reset()
    dat = load_audio(path)
    # Prepend silence for preprocessor warm-up
    pad = np.zeros(1280 * 16, dtype=np.int16)
    dat = np.concatenate([pad, dat])
    
    step = 1280
    all_feats = []
    
    for i in range(0, len(dat) - step + 1, step):
        chunk = dat[i:i+step]
        preds = oww.predict(chunk)
        try:
            feats = oww.preprocessor.get_features(oww.model_inputs[base_model])
            all_feats.append(feats.copy())
        except:
            pass
    
    if not all_feats:
        return np.empty((0, 16, 96))
    
    arr = np.array(all_feats)
    # Skip first 16 frames (the padding warm-up)
    if arr.shape[0] > 16:
        return arr[16:]
    return np.empty((0, 16, 96))


def main():
    print("\n=== OpenWakeWord Training ===")

    print("\n[1/4] TTS synthetic positives")
    n_tts_pos = generate_tts_positives()
    print(f"  TTS: {n_tts_pos} clips")

    print("\n[2/4] TTS negatives + ambient noise")
    n_neg = generate_tts_negatives()
    print(f"  Total negative: {n_neg} clips")

    print("\n[3/4] Extracting features...")
    import openwakeword
    from oww_utils import flatten_features
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    import pickle

    openwakeword.utils.download_models()
    oww = openwakeword.Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    base = "hey_jarvis"

    # Collect user-only positives if available (TTS voices don't match real voice)
    user_clips = []
    for slug in [p.lower().replace(" ", "_") for p in POSITIVE_PHRASES]:
        d = os.path.join(POS_DIR, slug)
        if os.path.isdir(d):
            user_clips.extend([os.path.join(d, f) for f in sorted(os.listdir(d)) if f.startswith("user_") and f.endswith(".wav")])

    if len(user_clips) >= 4:
        pos_clips = user_clips
        log.info(f"  Using {len(pos_clips)} user recordings ONLY as positives")
    else:
        pos_clips = []
        for slug in [p.lower().replace(" ", "_") for p in POSITIVE_PHRASES]:
            d = os.path.join(POS_DIR, slug)
            if os.path.isdir(d):
                pos_clips.extend([os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".wav")])
        log.info(f"  Using all {len(pos_clips)} clips as positives (TTS fallback)")

    pos_features_list = []
    for clip in pos_clips:
        feats = extract_features_per_clip(oww, base, clip, )
        if feats.shape[0] > 0:
            pos_features_list.append(feats)
    pos_features = np.vstack(pos_features_list) if pos_features_list else np.empty((0, 16, 96))
    log.info(f"  Positive clips={len(pos_clips)} frames={pos_features.shape[0]}")

    neg_clips = sorted([os.path.join(NEG_DIR, f) for f in os.listdir(NEG_DIR) if f.endswith(".wav")])
    neg_features_list = []
    for clip in neg_clips:
        feats = extract_features_per_clip(oww, base, clip, )
        if feats.shape[0] > 0:
            neg_features_list.append(feats)
    neg_features = np.vstack(neg_features_list) if neg_features_list else np.empty((0, 16, 96))
    log.info(f"  Negative clips={len(neg_clips)} frames={neg_features.shape[0]}")

    if pos_features.shape[0] < 10 or neg_features.shape[0] < 10:
        log.error("Too few features.")
        sys.exit(1)

    print("\n[4/4] Training...")
    X = np.vstack([pos_features, neg_features])
    y = np.array([1] * pos_features.shape[0] + [0] * neg_features.shape[0])

    clf = LogisticRegression(random_state=0, max_iter=2000, C=0.0001, class_weight="balanced")
    verifier = make_pipeline(FunctionTransformer(flatten_features), StandardScaler(), clf)
    verifier.fit(X, y)

    path = os.path.join(MODEL_DIR, "hey_echo_verifier.pkl")
    pickle.dump(verifier, open(path, "wb"))
    log.info(f"  Saved to {path}")

    print("\n=== EVALUATION ===")
    for label, clip_list in [("Positive", pos_clips[:10]), ("Negative", neg_clips[:15])]:
        scores = []
        for clip in clip_list:
            feats = extract_features_per_clip(oww, base, clip, )
            if feats.shape[0] > 0:
                s = verifier.predict_proba(feats.reshape(feats.shape[0], -1))[:, 1].max()
                scores.append(s)
        if scores:
            print(f"  {label}: min={min(scores):.3f} max={max(scores):.3f} mean={np.mean(scores):.3f}")

    if pos_features.shape[0] > 0 and neg_features.shape[0] > 0:
        pos_scores = verifier.predict_proba(pos_features.reshape(pos_features.shape[0], -1))[:, 1]
        neg_scores = verifier.predict_proba(neg_features.reshape(neg_features.shape[0], -1))[:, 1]
        best_thresh = max(float(np.percentile(neg_scores, 99)), 0.7) + 0.05
        print(f"  Recommended threshold (99th %ile of neg): {best_thresh:.3f}")

    print("\nDone.")


if __name__ == "__main__":
    main()
