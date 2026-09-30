import { describe, expect, it } from 'vitest';
import { endpointMs, SpeechGate } from '../src/endpoint.js';

describe('endpointMs', () => {
  it('answers soonest after a question, soon after a finished sentence', () => {
    expect(endpointMs('Can you hear me?')).toBe(300);
    expect(endpointMs('Bạn có nghe mình không?')).toBe(300);
    expect(endpointMs("That's all for today.")).toBe(800);
  });

  it('waits longer when the words trail off mid-thought', () => {
    for (const t of ['I want to check the', 'So I was thinking and', 'Let me see, um.', 'Mình muốn hỏi về dự án và', 'Well...', 'The thing is,']) {
      expect(endpointMs(t), t).toBe(1800);
    }
  });

  it('uses a middle wait otherwise', () => {
    expect(endpointMs('okay thanks')).toBe(900);
  });
});

describe('SpeechGate', () => {
  const noise = (ms: number, level = 0.01, clicks = true) => {
    const out = new Float32Array(16 * ms);
    for (let i = 0; i < out.length; i++) out[i] = (Math.random() - 0.5) * level * 2 + (clicks && i % 3200 < 20 ? (Math.random() - 0.5) * 0.3 : 0);
    return out;
  };
  const voice = (ms: number) => {
    const out = new Float32Array(16 * ms);
    for (let i = 0; i < out.length; i++) out[i] = Math.sin(i / 8) * 0.2;
    return out;
  };
  // The page's frame size: ~43 samples at a time.
  const feed = (gate: SpeechGate, pcm: Float32Array) => { for (let i = 0; i < pcm.length; i += 43) gate.push(pcm.subarray(i, i + 43)); };

  it('sees a pause through room noise and clicks', () => {
    const gate = new SpeechGate();
    feed(gate, noise(500));
    expect(gate.spoke).toBe(false);
    feed(gate, voice(800));
    expect(gate.spoke).toBe(true);
    feed(gate, noise(600));
    expect(gate.quietMs).toBeGreaterThanOrEqual(550);
  });
});
