#!/usr/bin/env python3
"""
OpenWakeWord experiment for Oasis Echo.

Narrowly scoped: replace only the wake-word inference step.
Keep existing pipeline structure (VAD trigger, chunk size, mic capture).

Usage:
    python3 run_experiment.py                    # test with hey_jarvis model
    python3 run_experiment.py --train-custom      # train + test "hey echo" model
    python3 run_experiment.py --model hey_echo    # test with trained custom model

Logs written to wakeword_experiment.log
"""

import argparse
import logging
import os
import queue
import sys
import threading
import time
from datetime import datetime, timezone

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("wakeword")

# ── imports ──────────────────────────────────────────────────────────
try:
    import sounddevice as sd
except ImportError:
    log.error("pip install sounddevice")
    sys.exit(1)

import openwakeword


# ── config ────────────────────────────────────────────────────────────
SAMPLE_RATE = 16000          # OpenWakeWord expects 16 kHz
CHUNK_SIZE = 1280             # 80 ms per chunk (OpenWakeWord's native frame)
MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
LOG_FILE = os.path.join(os.path.dirname(__file__), "wakeword_experiment.log")
SCORE_LOG = os.path.join(os.path.dirname(__file__), "score_trace.csv")


# ── experiment runner ─────────────────────────────────────────────────
class WakeWordExperiment:
    def __init__(self, model_names: list[str] | None = None, threshold: float = 0.5,
                 custom_verifier: str | None = None):
        self.threshold = threshold
        self.audio_queue: queue.Queue[np.ndarray] = queue.Queue()
        self.running = False
        self.scores: dict[str, list[float]] = {}
        self.detection_log: list[dict] = []

        # Ensure models are downloaded to the openwakeword package directory
        openwakeword.utils.download_models()

        # Load OpenWakeWord model(s)
        log.info("Loading OpenWakeWord model(s)…")
        cv_models = {}
        if custom_verifier:
            import pickle
            cv_path = custom_verifier if os.path.exists(custom_verifier) else \
                os.path.join(os.path.dirname(__file__), "models", custom_verifier)
            if os.path.exists(cv_path):
                cv_models["hey_jarvis"] = cv_path
                log.info(f"   Custom verifier: {cv_path}")
            else:
                log.warning(f"Custom verifier not found: {cv_path}")

        self.oww = openwakeword.Model(
            wakeword_models=model_names or [],
            inference_framework="onnx",
            custom_verifier_models=cv_models,
            custom_verifier_threshold=0.0,  # always run verifier (base model won't fire)
        )
        self.model_keys = list(self.oww.models.keys())
        for k in self.model_keys:
            self.scores[k] = []
        log.info(f"Loaded models: {self.model_keys}")

    def audio_callback(self, indata: np.ndarray, frames: int, _time_info, _status):
        """sounddevice callback — feeds audio chunks to the model."""
        if _status:
            log.warning(f"Audio status: {_status}")
        # sounddevice gives float32 [-1, 1]; convert to int16 PCM
        chunk = (indata[:, 0] * 32767).astype(np.int16)
        self.audio_queue.put(chunk)

    def run_stream(self, duration: float | None = None):
        """Capture mic and run OpenWakeWord inference, logging all scores."""
        self.running = True
        log.info(f"🎤 Starting mic capture @ {SAMPLE_RATE} Hz, chunk={CHUNK_SIZE} samples")
        log.info(f"   Threshold={self.threshold:.2f}, models={self.model_keys}")
        log.info("   Speak now — say 'Hey Echo' (or the target wake word) multiple times.")
        log.info("   Press Ctrl+C to stop.\n")

        # Open score CSV
        with open(SCORE_LOG, "w") as csv:
            cols = ["timestamp", "phrase"] + self.model_keys
            csv.write(",".join(cols) + "\n")
            csv.flush()

            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="float32",
                blocksize=CHUNK_SIZE,
                callback=self.audio_callback,
            ):
                start_time = time.monotonic()
                try:
                    while self.running:
                        if duration and (time.monotonic() - start_time) > duration:
                            break

                        chunk = self.audio_queue.get(timeout=0.5)
                        predictions = self.oww.predict(chunk)

                        ts = time.monotonic()
                        score_strs = []
                        for mdl in self.model_keys:
                            score = predictions.get(mdl, 0.0)
                            self.scores[mdl].append(score)
                            score_strs.append(f"{score:.4f}")

                        # Determine which model triggered
                        triggered = [mdl for mdl in self.model_keys if predictions.get(mdl, 0.0) >= self.threshold]

                        # Build CSV row
                        row = [
                            f"{datetime.now(timezone.utc).isoformat(timespec='milliseconds')}",
                            "|".join(triggered) if triggered else "",
                        ] + score_strs
                        csv.write(",".join(row) + "\n")
                        csv.flush()

                        # Console output — show any non-trivial score
                        max_score = max(predictions.values()) if predictions else 0.0
                        if max_score > 0.001 or triggered:
                            bar_len = 40
                            filled = int(bar_len * min(max_score, 1.0))
                            bar = "█" * filled + "░" * (bar_len - filled)
                            status = "✅ WAKE" if triggered else ""
                            log.info(f"  {bar} {max_score:.4f}  {status}")

                except KeyboardInterrupt:
                    pass
                except queue.Empty:
                    pass

        self.running = False
        log.info("\n📊 Experiment complete.")

    def print_summary(self):
        """Show summary statistics from the run."""
        if not self.scores:
            log.warning("No scores recorded.")
            return

        print("\n" + "=" * 60)
        print("SCORE SUMMARY")
        print("=" * 60)
        for mdl in self.model_keys:
            scores = np.array(self.scores[mdl])
            if len(scores) == 0:
                continue
            above_thresh = (scores >= self.threshold).sum()
            peak = scores.max()
            mean = scores.mean()
            p95 = np.percentile(scores, 95)
            print(f"\n  {mdl}:")
            print(f"    Frames evaluated: {len(scores)}")
            print(f"    Peak score:       {peak:.4f}")
            print(f"    Mean score:       {mean:.4f}")
            print(f"    P95 score:        {p95:.4f}")
            print(f"    Above threshold:  {above_thresh} frames")
        print("=" * 60)
        print(f"Full trace written to: {SCORE_LOG}\n")

    def detect_on_clip(self, clip_path: str):
        """Run detection on a pre-recorded WAV file (16-bit, 16 kHz, mono)."""
        import scipy.io.wavfile as wav

        log.info(f"Processing clip: {clip_path}")
        sr, data = wav.read(clip_path)
        if sr != SAMPLE_RATE:
            log.warning(f"Resampling needed: clip is {sr} Hz, expected {SAMPLE_RATE}")
        if data.dtype != np.int16:
            data = (data * 32767).astype(np.int16)
        if len(data.shape) > 1:
            data = data[:, 0]  # take first channel

        # Pad with silence
        data = np.concatenate([np.zeros(SAMPLE_RATE, dtype=np.int16), data, np.zeros(SAMPLE_RATE, dtype=np.int16)])

        print(f"\n📝 Processing clip: {os.path.basename(clip_path)}")
        print("-" * 50)
        peak_scores: dict[str, float] = {k: 0.0 for k in self.model_keys}

        for i in range(0, len(data) - CHUNK_SIZE, CHUNK_SIZE):
            chunk = data[i : i + CHUNK_SIZE]
            predictions = self.oww.predict(chunk)
            for mdl in self.model_keys:
                score = predictions.get(mdl, 0.0)
                peak_scores[mdl] = max(peak_scores[mdl], score)

        for mdl in self.model_keys:
            bar_len = 40
            filled = int(bar_len * min(peak_scores[mdl], 1.0))
            bar = "█" * filled + "░" * (bar_len - filled)
            triggered = peak_scores[mdl] >= self.threshold
            status = "✅" if triggered else ""
            print(f"  {mdl:20s}  {bar}  {peak_scores[mdl]:.4f}  {status}")
        print()

    def train_custom_model(self, model_name: str = "hey_echo"):
        """
        Train a custom verifier model for "Hey Echo" using the built-in
        OpenWakeWord custom_verifier_model module.
        """
        from openwakeword.custom_verifier_model import get_reference_clip_features, train_verifier_model

        pos_dir = os.path.join(os.path.dirname(__file__), "recordings", "hey_echo")
        neg_dir = os.path.join(os.path.dirname(__file__), "recordings", "other_speech")
        os.makedirs(pos_dir, exist_ok=True)
        os.makedirs(neg_dir, exist_ok=True)

        print("\n📝 Custom Model Training")
        print("=" * 60)
        print(f"Positive samples dir: {pos_dir}")
        print(f"Negative samples dir: {neg_dir}")
        print("\nInstructions:")
        print("  1. Say 'Hey Echo' ~10 times and save each as a WAV file")
        print("     (16-bit, 16kHz, mono) in the positive dir.")
        print("  2. Record ~10 clips of random speech WITHOUT 'Hey Echo'")
        print("     in the negative dir.")
        print("  3. Run this script again with --train-custom\n")

        pos_clips = sorted([os.path.join(pos_dir, f) for f in os.listdir(pos_dir) if f.endswith(".wav")])
        neg_clips = sorted([os.path.join(neg_dir, f) for f in os.listdir(neg_dir) if f.endswith(".wav")])

        if len(pos_clips) < 3:
            log.error(f"Need at least 3 positive clips, found {len(pos_clips)} in {pos_dir}")
            log.info("Recording tool: python3 record_samples.py")
            return

        if len(neg_clips) < 3:
            log.error(f"Need at least 3 negative clips, found {len(neg_clips)} in {neg_dir}")
            return

        log.info(f"Found {len(pos_clips)} positive, {len(neg_clips)} negative clips")

        # Use first pre-trained model as the base for embedding
        base_model_name = self.model_keys[0]

        # Extract positive features
        log.info("Extracting positive features…")
        pos_features = np.vstack([
            get_reference_clip_features(c, self.oww, base_model_name, N=5, threshold=self.threshold * 0.8)
            for c in pos_clips
        ])
        if pos_features.shape[0] == 0:
            log.error("No positive features extracted. Try lowering threshold or re-recording.")
            return

        # Extract negative features
        log.info("Extracting negative features…")
        neg_features = np.vstack([
            get_reference_clip_features(c, self.oww, base_model_name, threshold=0.0, N=1)
            for c in neg_clips
        ])

        # Train verifier
        log.info(f"Training verifier on {pos_features.shape[0]} positive, {neg_features.shape[0]} negative samples…")
        X = np.vstack([pos_features, neg_features])
        y = np.array([1] * pos_features.shape[0] + [0] * neg_features.shape[0])
        verifier = train_verifier_model(X, y)

        # Save
        output_path = os.path.join(MODEL_DIR, f"{model_name}_verifier.pkl")
        import pickle
        pickle.dump(verifier, open(output_path, "wb"))
        log.info(f"✅ Custom verifier saved to {output_path}")
        log.info(f"Run with: python3 run_experiment.py --model {model_name}")


def record_with_ffmpeg(phrase: str, duration: float = 3.0, output_dir: str = ""):
    """Record a WAV clip using ffmpeg (no interactive prompts needed)."""
    import subprocess
    output_dir = output_dir or os.path.join(os.path.dirname(__file__), "recordings", phrase)
    os.makedirs(output_dir, exist_ok=True)
    existing = len([f for f in os.listdir(output_dir) if f.endswith(".wav")])
    out_path = os.path.join(output_dir, f"{phrase}_{existing + 1:02d}.wav")

    print(f"🎤 Recording {duration}s of '{phrase}' to {out_path}…")
    subprocess.run([
        "ffmpeg", "-f", "avfoundation", "-i", ":0",
        "-t", str(duration),
        "-ar", str(SAMPLE_RATE), "-ac", "1", "-sample_fmt", "s16",
        "-y", out_path
    ], capture_output=True)
    if os.path.exists(out_path):
        print(f"   ✅ Saved ({os.path.getsize(out_path)} bytes)")
    return out_path


def record_samples():
    """Simple recording tool to capture WAV clips for custom training."""
    import scipy.io.wavfile as wav
    import subprocess

    sample_dir = os.path.join(os.path.dirname(__file__), "recordings")
    os.makedirs(sample_dir, exist_ok=True)

    print("\n🎤 Recording Tool")
    print("=" * 60)
    phrase = "hey_echo"
    n_samples = 5
    duration = 2.0

    phrase_dir = os.path.join(sample_dir, phrase)
    os.makedirs(phrase_dir, exist_ok=True)

    existing = len([f for f in os.listdir(phrase_dir) if f.endswith(".wav")])

    print(f"Recording {n_samples} samples of '{phrase}' ({duration}s each)")
    print("Say the phrase clearly after each beep.\n")

    for i in range(n_samples):
        print(f"  [{i + 1}/{n_samples}] Say '{phrase}' NOW...")
        out_path = os.path.join(phrase_dir, f"{phrase}_{existing + i + 1:02d}.wav")
        subprocess.run([
            "ffmpeg", "-f", "avfoundation", "-i", ":0",
            "-t", str(duration),
            "-ar", str(SAMPLE_RATE), "-ac", "1", "-sample_fmt", "s16",
            "-y", out_path
        ], capture_output=True)
        print(f"    Saved: {out_path}")

    print(f"\n✅ Recorded {n_samples} samples to {phrase_dir}")
    print(f"   Next: record negative samples (other speech) or train:")
    print(f"   python3 run_experiment.py --train-custom")


# ── main ──────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="OpenWakeWord experiment for Oasis Echo")
    parser.add_argument("--model", nargs="*", default=None,
                        help="Specific model name(s) to load (default: all pre-trained)")
    parser.add_argument("--threshold", type=float, default=0.5,
                        help="Detection threshold (default: 0.5)")
    parser.add_argument("--duration", type=float, default=None,
                        help="Run duration in seconds (default: indefinite)")
    parser.add_argument("--clip", type=str, default=None,
                        help="Run on a pre-recorded WAV file instead of live mic")
    parser.add_argument("--record", action="store_true",
                        help="Record samples for custom model training")
    parser.add_argument("--train-custom", action="store_true",
                        help="Train custom verifier model from recorded samples")
    parser.add_argument("--retrain", action="store_true",
                        help="Record 5 real samples then retrain the verifier")
    parser.add_argument("--custom-model", type=str, default="hey_echo",
                        help="Name for custom model (default: hey_echo)")
    parser.add_argument("--custom-verifier", type=str, default=None,
                        help="Path to custom verifier .pkl file")
    parser.add_argument("--verifier-threshold", type=float, default=0.5,
                        help="Detection threshold for wake-word activation (default: 0.5)")
    parser.add_argument("--verbose", action="store_true",
                        help="Log every frame score")
    parser.add_argument("--quick-record", type=str, default=None, metavar="PHRASE",
                        help="Record N seconds of audio (non-interactive, uses ffmpeg)")
    parser.add_argument("--verify", type=str, default=None, metavar="WAV_PATH",
                        help="Quick record + test: record clip then run detection")

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Quick record (non-interactive)
    if args.quick_record:
        record_with_ffmpeg(args.quick_record)
        return

    # Verify = record + test in one step
    if args.verify:
        model_names = args.model or ["hey_jarvis"]
        clip = record_with_ffmpeg("verify", duration=3.0)
        exp = WakeWordExperiment(
            model_names=model_names,
            threshold=args.threshold,
            custom_verifier=args.custom_verifier,
        )
        exp.detect_on_clip(clip)
        return

    # Handle sub-commands
    if args.record:
        record_samples()
        return

    if args.retrain:
        print("\n🎤 Retrain mode: record 5 real samples, then retrain")
        print("=" * 60)
        base = os.path.dirname(__file__)
        hey_dir = os.path.join(base, "recordings", "wake_phrases", "hey_echo")
        echo_dir = os.path.join(base, "recordings", "wake_phrases", "echo_echo")
        os.makedirs(hey_dir, exist_ok=True)
        os.makedirs(echo_dir, exist_ok=True)

        import subprocess
        sr = 16000
        for i in range(5):
            path = os.path.join(hey_dir, f"user_hey_echo_{i+1:02d}.wav")
            print(f"\n  [{i+1}/5] Say 'Hey Echo' NOW (recording 2.5s)...")
            subprocess.run(["ffmpeg", "-f", "avfoundation", "-i", ":0",
                           "-t", "2.5", "-ar", str(sr), "-ac", "1",
                           "-sample_fmt", "s16", "-y", path],
                          capture_output=True)
            print(f"    Saved: {os.path.basename(path)} ({os.path.getsize(path)} bytes)")

        for i in range(5):
            path = os.path.join(echo_dir, f"user_echo_echo_{i+1:02d}.wav")
            print(f"\n  [{i+1}/5] Say 'Echo Echo' NOW (recording 2.5s)...")
            subprocess.run(["ffmpeg", "-f", "avfoundation", "-i", ":0",
                           "-t", "2.5", "-ar", str(sr), "-ac", "1",
                           "-sample_fmt", "s16", "-y", path],
                          capture_output=True)
            print(f"    Saved: {os.path.basename(path)} ({os.path.getsize(path)} bytes)")

        print("\n🧠 Retraining verifier with your real samples...")
        subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "train_hey_echo.py")])
        return

    exp = WakeWordExperiment(
        model_names=args.model,
        threshold=args.threshold,
        custom_verifier=args.custom_verifier,
    )

    if args.train_custom:
        exp.train_custom_model(model_name=args.custom_model)
        return

    if args.clip:
        exp.detect_on_clip(args.clip)
        return

    # Live mic experiment
    print("\n🎤 Live wake-word experiment")
    print("=" * 60)
    print(f"Model(s): {args.model or 'all pre-trained'}")
    print(f"Threshold: {args.threshold}")
    print("Say the wake word multiple times during the capture.")
    print("Scores stream below. Press Ctrl+C to stop.\n")
    exp.run_stream(duration=args.duration)
    exp.print_summary()


if __name__ == "__main__":
    main()
