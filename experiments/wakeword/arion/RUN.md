# Retraining the Arion wake-word heads

The scripts assume the work directory is `/Volumes/Data/dev/wakeword-arion` (the `ROOT` constant). There are two venvs: one with torch, onnx, openwakeword, librosa, pyarrow and faster-whisper, and the VieNeu one for `gen_vi.py`. Audio and features stay out of git.

1. `gen_vi.py` (VieNeu venv, cwd `/Volumes/Data/dev/vieneu`), `node gen_en.mjs jobs.json` (Kokoro) and `gen_say.py` (macOS `say`) generate the TTS clips into `tts/`.
2. `filter_vi.py` uses PhoWhisper to drop VieNeu clips that don't contain the phrase.
3. Download into `data/`: FLEURS vi_vn, GTZAN (confit/gtzan-parquet), MUSAN noise, the openWakeWord ACAV100M features (first 3 GB) and validation features, VLSP2020 VinAI shards 0–4 and viet_youtube_asr_corpus_v2 train shards 0–3 plus test shard 0.
4. `build_features.py all`, then `build_features.py more`, compute the embeddings into `feats/`.
5. Train with `train.py arion --hidden 64 --steps 40000` and `train.py hey --hidden 64 --steps 40000`.
6. Evaluate with `PATIENCE=2 evaluate.py out/<model>.onnx arion|hey`, then run `summ.py` and `confusables.py`.

See `../models/README_arion_wakeword.md` for the results.

## v2: the single `arion.onnx` head ("Arion" + "ri-on" / "Rion" / "Ryan" + "Arion ơi" / "Hey Arion")

1. Generate the new clips:
   - `gen_vi_word.py`, `gen_vi_rion.py` and `gen_vi_ryan.py` in the VieNeu venv.
   - Kokoro jobs for `pos_word/`, `pos_rion/`, `pos_ryan/` and `lookalike/`, then `gen_say2.py`.
   - Run `filter_vi2.py`.
2. `build_v2.py train`, then `build_v2.py eval`.
3. `train.py arion2 --hidden 64 --steps 40000 --negtts neg_tts2_train --fa_target 1.0` (`--groups` trains on a subset of the variant groups).
4. `PATIENCE=2 THRS=0.1,0.2,0.3,0.4,0.5,0.6,0.7 evaluate_v2.py out/<model>.onnx`, then `summ2.py <json> look`. Use `a.onnx+b.onnx` to evaluate an OR of heads.
