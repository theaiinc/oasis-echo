# Arion wake word

openWakeWord-style keyword heads for the Arion driving assistant. They run on the phone, fully offline, on the stock `melspectrogram.onnx` and `embedding_model.onnx`.

## v2 (2026-10-11): `arion.onnx`, one head for "Arion" and its variants

| file | size | wakes on |
|---|---|---|
| `arion.onnx` | 415 KB (414,670 B) | "Arion" (vi "a ri ôn", en "AIR-ee-on" / "uh-RYE-on"), clipped "ri-on", "Rion", "Ryan", plus "Arion ơi" and "Hey Arion" |
| `arion_eval.json` | | full held-out results (patience 2, thresholds 0.1 to 0.7) |

It uses the same I/O as the other heads: `input` [batch, 16, 96] → `output` [batch, 1].

**Operating point: threshold 0.4, patience 2** (score ≥ 0.4 on 2 consecutive 80 ms frames), 2 s refractory.

### The targets were not met

The owner's targets were ≥ 99 % recall in a quiet car and ≥ 97 % at 5 dB car noise, with ≤ ~1 false wake per hour. One head cannot reach all three. Even at threshold 0.1, where false wakes rise to 3.5 / h, overall recall is 95 % quiet and 88 % at 5 dB.

The short forms are the cost. "ri-on", "Rion" and "Ryan" are two syllables that sound like everyday words. I also tried splitting into two heads (three-syllable forms and short forms, OR-ed in the app) and a 2× larger head (128 units). At the same false-wake rate, neither gained more than about 1–2 points of recall.

### Recall: held-out voices, threshold 0.4, patience 2

| variant (clips) | quiet | car 10 dB | car 5 dB | car 0 dB |
|---|---|---|---|---|
| Arion (384) | 97.1 % | 92.7 % | 86.7 % | 74.7 % |
| a ri on, spelled (106) | 100 % | 98.1 % | 89.6 % | 82.1 % |
| ri-on (160) | 99.4 % | 91.3 % | 86.9 % | 73.1 % |
| Rion (150) | 94.0 % | 84.7 % | 87.3 % | 69.3 % |
| Ryan (146) | 91.1 % | 89.0 % | 76.0 % | 62.3 % |
| Arion ơi (222) | 96.8 % | 96.4 % | 92.3 % | 78.8 % |
| Hey Arion (322) | 75.8 % | 70.2 % | 65.2 % | 50.6 % |
| **all (1,490)** | **92.0 %** | **87.5 %** | **82.2 %** | **68.7 %** |

### Trade-off (patience 2)

FA/h is false wakes per hour over 31.9 h of held-out audio: real Vietnamese speech (YouTube, FLEURS; clean and with car noise), music with car noise, car noise alone, MUSAN noise, and the English openWakeWord validation set.

| threshold | recall quiet | recall 5 dB | FA/h |
|---|---|---|---|
| 0.1 | 95.2 % | 88.2 % | 3.5 |
| 0.2 | 93.8 % | 85.4 % | 2.2 |
| 0.3 | 92.6 % | 83.8 % | 1.4 |
| **0.4** | **92.0 %** | **82.2 %** | **1.0** |
| 0.5 | 91.0 % | 80.0 % | 0.72 |
| 0.7 | 89.3 % | 75.8 % | 0.44 |

Patience 1 gives a few points more recall but about twice the false wakes. For example, at threshold 0.7: 92.7 % quiet / 82.7 % at 5 dB with 1.7 / h.

At 0.4 the false wakes break down per hour as follows:

| source | FA/h |
|---|---|
| English openWakeWord validation speech | 2.1 |
| FLEURS Vietnamese, clean | 1.6 |
| YouTube Vietnamese + car noise | 0.58 |
| FLEURS + car noise | 0.31 |
| YouTube Vietnamese, clean | 0.19 |
| music + car noise | 0 |
| car noise | 0 |

### Look-alikes: share of isolated held-out-voice clips that wake it (threshold 0.4, patience 2)

- **Vietnamese:**
  - Never: "rồi", "xong rồi", "được rồi anh", "rõ rồi", "ra rồi", "ừ, rồi", "rời đi", "rời khỏi đây", "ôn bài", "ôn tập", "Ri.", "Ri ơi", "rì rầm", "Rồi ông ơi", "anh ơi", "em ơi", "trời ơi".
  - Sometimes: "riêng" 8 %, "Ari ơi" 8 %, "Bà Ri ơi" 8 %.
  - Almost always: "Marion ơi" 83 %, "Orion" 100 %.
  - Sentences that mention the product name ("Mở Arion lên coi" 50 %, "Ứng dụng Arion hay lắm" 58 %) wake it, as expected.
- **English:**
  - Never: "lion", "a lion", "the Rhine river", "right on", "right on time", "Irene", "neon lights", "rain on the road".
  - Sometimes: "Brian" 31 %, "Rio" 25 %, "Hey Marion" 31 %, "Hey Darian" 25 %, "Hey Aaron" 13 %, "Iron" 6 %, "Leon" 6 %.
  - Almost always: "Orion" 94 %, "Hey Orion" 63 %.
  - "Hey Ryan" 38 % — counted under Ryan, which is now a positive.

### `arion_any.onnx`: the shipping file (829,755 B)

`arion_any.onnx` is `arion.onnx` and `arion_oi.onnx` merged into one graph whose output is `Max` of the two scores. I checked the output against the max of the two heads and it is identical. The app applies threshold, patience and refractory to that single score.

Held-out evaluation, run exactly as the app uses the file (patience 2, 2 s refractory):

| variant (clips) | quiet @0.4 | 5 dB @0.4 | quiet @0.5 | 5 dB @0.5 |
|---|---|---|---|---|
| Arion (384) | 97.1 % | 86.7 % | 96.6 % | 85.2 % |
| "a ri on" (106) | 100 % | 89.6 % | 100 % | 88.7 % |
| ri-on (160) | 99.4 % | 86.9 % | 98.8 % | 85.0 % |
| Rion (150) | 94.0 % | 87.3 % | 90.7 % | 84.7 % |
| Ryan (146) | 91.1 % | 76.0 % | 89.0 % | 72.6 % |
| Arion ơi (222) | 99.1 % | 98.2 % | 98.2 % | 97.3 % |
| Hey Arion (322) | 75.8 % | 65.2 % | 75.2 % | 62.4 % |
| **all (1,490)** | **92.4 %** | **83.0 %** | **91.3 %** | **81.0 %** |

False wakes per hour over 31.9 h of held-out audio:

| threshold | false wakes / h |
|---|---|
| 0.3 | 1.51 |
| **0.4** | **1.13** |
| 0.5 | 0.82 |
| 0.6 | 0.60 |

The look-alike rates match `arion.onnx` with one exception: "Ari ơi" rises to 42 %, because the `arion_oi` head contributes. "Rồi", "rời", "ôn", "Ri ơi", "lion", "right on" and "Rhine" still never wake it. "Riêng" stays at 8 %, "Brian" at 31 %, "Marion ơi" at 83 % and "Orion" at 94–100 %.

**Recommended threshold: 0.4.** It is about 1.1 false wakes per hour, within the owner's "~1 / h". Use 0.5 if ≤ 1 / h must be strict: it costs about 1–2 points of recall per variant (3.4 for Ryan at 5 dB, 2.8 for Hey Arion).

### Recommendation

"Arion ơi" is much easier to detect reliably than a bare "Arion". Run **`arion.onnx` OR `arion_oi.onnx`** (the v1 head below, both at threshold 0.4 and patience 2):

- "Arion ơi" recall rises to 99.1 % quiet / 98.2 % at 5 dB.
- Total false wakes go to 1.13 / h.
- Everything else keeps the numbers above.

Encourage drivers to say "Arion ơi" (or "Arion" clearly) rather than "Ryan" / "Rion".

### How v2 was trained

The pipeline, augmentation and long negative streams are the same as v1. What is new:

- **Positives:**
  - VieNeu, all 25 voices: "Arion" spellings at 3 temperatures, plus "ri ôn" / "Rion" / "Ryan" (rejected by the PhoWhisper sanity filter: 4).
  - Kokoro: 28 voices, 3 speeds.
  - macOS `say`: 21 English voices plus Linh.
  - "Arion ơi" and "Hey Arion" from v1.
  - In 30 % of the "Arion" and "ri-on" augmentations the start fades in (a barely-voiced "A").
  - Wider end jitter (0–350 ms) and noisier mixes (−5 to 22 dB SNR).
- **Negatives:** v1 negatives, minus texts that now contain the word or near-misses we chose not to punish ("Arion", "Marion ơi", "Orion", "Hey Marian/Darian", …). Added Vietnamese look-alikes ("rồi", "rời", "riêng", "ôn", "Ri ơi", …) and English ones ("Brian", "lion", "Rhine", "right on", …), with held-out voices kept for the look-alike test.
- **Model:** Head(64): 40k steps, best validation checkpoint (step 37.5k).

### Limits

All the v1 limits below still apply. The biggest: **no real human recordings**, so real recall may differ, and the FA/h numbers are counts of 1–30 events. The English-speech false wakes (2.1 / h at 0.4) matter less for Vietnamese cabins but are real.

---

# v1 (2026-10-08): "Arion ơi" / "Hey Arion" heads

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
