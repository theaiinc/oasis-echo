# Retraining the Arion wake-word heads

The scripts assume the work directory is `/Volumes/Data/dev/wakeword-arion` (the `ROOT` constant). There are two venvs: one with torch, onnx, openwakeword, librosa, pyarrow and faster-whisper, and the VieNeu one for `gen_vi.py`. Audio and features stay out of git.

1. `gen_vi.py` (VieNeu venv, cwd `/Volumes/Data/dev/vieneu`), `node gen_en.mjs jobs.json` (Kokoro) and `gen_say.py` (macOS `say`) generate the TTS clips into `tts/`.
2. `filter_vi.py` uses PhoWhisper to drop VieNeu clips that don't contain the phrase.
3. Download into `data/`: FLEURS vi_vn, GTZAN (confit/gtzan-parquet), MUSAN noise, the openWakeWord ACAV100M features (first 3 GB) and validation features, VLSP2020 VinAI shards 0–4 and viet_youtube_asr_corpus_v2 train shards 0–3 plus test shard 0.
4. `build_features.py all`, then `build_features.py more`, compute the embeddings into `feats/`.
5. Train with `train.py arion --hidden 64 --steps 40000` and `train.py hey --hidden 64 --steps 40000`.
6. Evaluate with `PATIENCE=2 evaluate.py out/<model>.onnx arion|hey`, then run `summ.py` and `confusables.py`.

See `../models/README_arion_wakeword.md` for the results.
