import { describe, expect, it } from 'vitest';
import { WhisperStreamingStt } from '../src/streaming-stt.js';

const SAMPLE_RATE = 16000;

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SAMPLE_RATE));
}

describe('WhisperStreamingStt rolling buffer overflow', () => {
  it('accounts for every fed sample even when the capture runs well past maxBufferSeconds', async () => {
    // Regression test: feed() used to drop audio pushed off the head of
    // the rolling buffer in small (tens-of-ms) slivers once the buffer
    // was full, because commitDroppedHead() silently discarded any
    // chunk shorter than minBufferSamples. In the steady state (buffer
    // already at cap, each feed() overflows by ~one chunk) that
    // condition was always true, so a long capture progressively lost
    // more and more of its beginning the longer it ran.
    const seenLengths: number[] = [];
    const stt = new WhisperStreamingStt({
      maxBufferSeconds: 2,
      minBufferSeconds: 0.5,
      loader: async () => ({
        pipeline: async () => {
          return (async (samples: Float32Array) => {
            seenLengths.push(samples.length);
            return { text: '' };
          }) as unknown;
        },
      }),
    });

    // Mimic real mic buffers: lots of small (~20ms) chunks, well past
    // the 2s rolling window.
    const chunk = silence(0.02);
    const totalSeconds = 6; // 3x the buffer window
    const chunkCount = Math.round(totalSeconds / 0.02);
    for (let i = 0; i < chunkCount; i++) {
      stt.feed(chunk);
    }

    await stt.transcribeAll();

    const totalFed = chunkCount * chunk.length;
    const totalAccounted = seenLengths.reduce((sum, len) => sum + len, 0);

    // Every sample should have reached an inference call at some point
    // — either as part of a committed dropped-head chunk or in the
    // final buffer. Only slack allowed: the very last forced flush
    // skips a sub-300ms tail (matches Whisper's hallucination floor).
    expect(totalAccounted).toBeGreaterThan(totalFed - SAMPLE_RATE * 0.3);
    expect(totalAccounted).toBeLessThanOrEqual(totalFed);
  });

  it('resets pendingDrop so a fresh utterance does not inherit a stale partial chunk', async () => {
    const seenLengths: number[] = [];
    const stt = new WhisperStreamingStt({
      maxBufferSeconds: 1, // 16000 samples
      // High enough that pendingDrop never auto-commits mid-feed in
      // this test — only the forced flush in transcribeAll() commits it.
      minBufferSeconds: 10,
      loader: async () => ({
        pipeline: async () => {
          return (async (samples: Float32Array) => {
            seenLengths.push(samples.length);
            return { text: '' };
          }) as unknown;
        },
      }),
    });

    const chunk = silence(0.1); // 1600 samples; 10 chunks exactly fill the 1s cap
    // Utterance A: overflow by 10 more chunks (1s = 16000 samples)
    // worth of dropped-but-uncommitted head, then reset.
    for (let i = 0; i < 20; i++) stt.feed(chunk);
    stt.reset();

    // Utterance B: same overflow pattern. If reset() failed to clear
    // pendingDrop, this utterance's forced flush would carry ~2s
    // (32000 samples) of stale + fresh audio instead of just its own 1s.
    for (let i = 0; i < 20; i++) stt.feed(chunk);
    await stt.transcribeAll();

    const totalAccounted = seenLengths.reduce((sum, len) => sum + len, 0);
    expect(totalAccounted).toBe(16000);
  });
});
