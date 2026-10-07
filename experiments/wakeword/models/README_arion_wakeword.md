# Arion wake word ("Arion ơi" / "Hey Arion")

openWakeWord-style keyword heads for the Arion driving assistant. They run on the phone, fully offline.

## Files

| file | size | what |
|---|---|---|
| `arion_oi.onnx` | 415 KB | **primary** head, "Arion ơi" (Vietnamese) |
| `hey_arion.onnx` | 415 KB | secondary head, "Hey Arion" (English + Vietnamese-accented) |
| `melspectrogram.onnx` | 1.09 MB | shared openWakeWord feature model (unchanged; same file the app already ships) |
| `embedding_model.onnx` | 1.33 MB | shared openWakeWord embedding model (unchanged; same file the app already ships) |
| `arion_oi_eval.json`, `hey_arion_eval.json` | | held-out evaluation numbers |

Each head takes input `input` with shape `[batch, 16, 96]` (the last 16 embeddings) and returns `output` with shape `[batch, 1]`, a score from 0 to 1. The pipeline is the stock openWakeWord one: 16 kHz int16 audio in 1280-sample (80 ms) frames goes through melspectrogram.onnx (x/10 + 2), then embedding_model.onnx (76 mel frames, hop 8), then the head. The two heads are separate models that share the feature models. Run either one or both on the same embeddings; each extra head costs about 0.1 M multiply-adds per 80 ms.

## Detection settings

| head | threshold | patience | refractory |
|---|---|---|---|
| `arion_oi` | **0.5** | **2 frames in a row** | 2 s |
| `hey_arion` | **0.5** | **2 frames in a row** | 2 s |

Patience matters. With 1 frame, the false accepts on Vietnamese speech in car noise go up about 3x (see below).

## Held-out results (patience 2, threshold 0.5, 2 s refractory)

**Recall** uses voices never seen in training. Each phrase sits in 4 s of background (car noise + music / babble / MUSAN noise) with car-cabin reverb and phone-mic EQ.

| condition | Arion ơi (222 clips) | Hey Arion (322 clips) |
|---|---|---|
| quiet | 98.6 % | 83.9 % |
| car noise, 10 dB SNR | 97.7 % | 74.5 % |
| car noise, 5 dB SNR | 94.1 % | 67.1 % |
| car noise, 0 dB SNR | 90.1 % | 56.2 % |

**False accepts per hour** on 31.9 h of held-out negative audio. Most of it is real speech, and none of it was used in training.

| source (hours) | Arion ơi | Hey Arion |
|---|---|---|
| YouTube Vietnamese speech, clean (5.2 h) | 0 | 0.19 |
| YouTube Vietnamese speech + car noise 5–20 dB (5.2 h) | 0.19 | 0.39 |
| FLEURS Vietnamese read speech, clean (3.2 h) | 0 | 0 |
| FLEURS Vietnamese + car noise (3.2 h) | 0 | 0.31 |
| music (GTZAN test) + car noise (2 h) | 0 | 0 |
| synthetic car-cabin noise (2 h) | 0 | 0 |
| MUSAN noise (0.5 h) | 0 | 0 |
| openWakeWord validation set, English speech/noise/music (10.7 h) | 0 | 0.47 |
| **total** | **0.09 / h** | **0.28 / h** |

Stress test, not counted above: 1.35 h of dense held-out-voice TTS made up of in-car phrases plus deliberate sound-alikes (each one 3 times). Here Arion ơi gets 14 FA/h and Hey Arion 9.6 FA/h. Per phrase in isolation (Arion ơi, threshold 0.5): "Ari ơi" is accepted 42 % of the time, "An ơi" 17 %, "Marion ơi" 17 % and "Anh Ri ơi" 8 %. "Anh ơi", "Em ơi", "Trời ơi" and "Arion" without "ơi" are accepted 0 % of the time.

## How it was trained

The scripts are in `experiments/wakeword/arion/`. The large data lives on the Mac in `/Volumes/Data/dev/wakeword-arion` and is not in git.

- Positives:
  - VieNeu-TTS v3 Turbo: all 25 voices, including Southern and Central ones. Seven spellings of "Arion ơi" and four of "Hey Arion", each at several sampling temperatures.
  - PhoWhisper was used to filter out clips where the TTS mangled the phrase. 128 of 716 were dropped.
  - Kokoro: 28 English voices × 3 speeds.
  - macOS `say`: 21 English voices plus the Vietnamese voice Linh.
  - Held out for testing: 5 VieNeu voices (Mỹ Duyên, Đức Trí, Ngọc Trân, Quốc Tuấn, Đoan Trang), Linh, 4 Kokoro voices and 4 `say` voices.
- Augmentation: speed 0.88–1.15, synthetic car-cabin impulse response (RT60 40–250 ms), phone/Bluetooth mic EQ, and mixing at −2 to 22 dB SNR. The noise is procedural car noise (engine harmonics, tyre and road rumble, wind, A/C fan, indicator ticks, rain, bumps), optionally with GTZAN music, Vietnamese babble or MUSAN noise.
- Negatives:
  - About 2,400 TTS sentences of in-car speech and sound-alikes ("anh ơi", "em ơi", "Ari ơi", "Marion ơi", "Arion" alone, "Hey Aaron", "Hey Siri", …).
  - Real Vietnamese speech, about 47 h: FLEURS vi train, VLSP2020 VinAI shards 0–3 and YouTube ASR corpus shards 0–3, mixed with car noise.
  - Car noise, music and MUSAN noise.
  - 0.98 M windows (the first 3 GB) of openWakeWord's precomputed ACAV100M features.
- Model: Flatten → Linear(1536, 64) → LayerNorm → ReLU → Dropout 0.3 → Linear(64, 64) → LayerNorm → ReLU → Dropout → Linear(64, 1) → Sigmoid. It was trained with AdamW, weight decay 1e-2, Gaussian feature noise, a negative weight ramped up to 30×, hard-negative mining every 3k steps, and 40k steps.

## Limits

- **No real human recordings of the phrase were used**, neither for training nor for testing. All positives are TTS. Before shipping widely, record about 20 real drivers saying "Arion ơi" in a car, check recall, and retune the threshold.
- "Hey Arion" is noticeably weaker:
  - The macOS Daniel voice (British) is never detected, and noisy recall is low.
  - Kokoro and VieNeu voices score 92–100 % in quiet.
  - Treat it as optional or experimental.
- Names that sound almost the same ("Ari ơi", "Marion ơi", "An ơi") will sometimes wake it.
- Measured FA/h comes from about 32 h of audio. A rate of 0.09 / h means 3 events, so the confidence interval is wide.
- The training data includes third-party research datasets: openWakeWord's ACAV100M feature set (YouTube-derived), GTZAN music, FLEURS, VLSP2020 and the YouTube ASR corpus. Their licences are mixed, and some are research or non-commercial. Check these before commercial distribution, or retrain without them. The training scripts make that easy.
