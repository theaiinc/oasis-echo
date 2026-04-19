import { describe, expect, it } from 'vitest';
import { decodeBase64Pcm16, scheduleChunk } from '../src/directives.js';

describe('scheduleChunk', () => {
  it('is a pass-through when no directives are provided', () => {
    const plan = scheduleChunk({
      ctxTime: 0,
      queueEndsAt: 0,
      chunkDurationSec: 1,
    });
    expect(plan.playbackRate).toBe(1);
    expect(plan.gain).toBe(1);
    expect(plan.startAt).toBe(0);
    expect(plan.endAt).toBe(1);
  });

  it('applies playbackRate and shortens effective duration', () => {
    const plan = scheduleChunk({
      ctxTime: 0,
      queueEndsAt: 0,
      chunkDurationSec: 1,
      directives: {
        playbackRate: 1.2,
        gain: 1,
        interChunkSilenceMs: 0,
        pitchSemitones: 0,
        ssml: '',
      },
    });
    expect(plan.playbackRate).toBe(1.2);
    expect(plan.endAt).toBeCloseTo(1 / 1.2, 5);
  });

  it('stretches effective duration when playback rate < 1', () => {
    const plan = scheduleChunk({
      ctxTime: 0,
      queueEndsAt: 0,
      chunkDurationSec: 1,
      directives: {
        playbackRate: 0.9,
        gain: 1,
        interChunkSilenceMs: 0,
        pitchSemitones: 0,
        ssml: '',
      },
    });
    expect(plan.endAt).toBeCloseTo(1 / 0.9, 5);
  });

  it('inserts inter-chunk silence after previous queue head', () => {
    const plan = scheduleChunk({
      ctxTime: 0,
      queueEndsAt: 5,
      chunkDurationSec: 1,
      directives: {
        playbackRate: 1,
        gain: 1,
        interChunkSilenceMs: 280,
        pitchSemitones: 0,
        ssml: '',
      },
    });
    expect(plan.startAt).toBeCloseTo(5.28, 5);
    expect(plan.endAt).toBeCloseTo(6.28, 5);
  });

  it('never schedules earlier than the current context time', () => {
    const plan = scheduleChunk({
      ctxTime: 10,
      queueEndsAt: 3,
      chunkDurationSec: 1,
    });
    expect(plan.startAt).toBe(10);
  });

  it('composes extraGain multiplicatively with emotion gain', () => {
    const plan = scheduleChunk({
      ctxTime: 0,
      queueEndsAt: 0,
      chunkDurationSec: 1,
      directives: {
        playbackRate: 1,
        gain: 0.9,
        interChunkSilenceMs: 0,
        pitchSemitones: 0,
        ssml: '',
      },
      extraGain: 0.5,
    });
    expect(plan.gain).toBeCloseTo(0.45, 5);
  });
});

describe('decodeBase64Pcm16', () => {
  it('decodes into Float32 values in [-1, 1]', () => {
    // Encode two 16-bit signed samples: 16384 (0.5) and -16384 (-0.5)
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0]);
    const base64 = btoa(String.fromCharCode(...bytes));
    const out = decodeBase64Pcm16(base64);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.5, 4);
    expect(out[1]).toBeCloseTo(-0.5, 4);
  });
});
