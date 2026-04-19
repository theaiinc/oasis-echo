import { describe, expect, it } from 'vitest';
import {
  EmotionAdaptiveTts,
  EmotionMapper,
  StrategyResolver,
  TtsAdapter,
  clampParams,
  emotionValence,
  normalizeSerLabel,
} from '../src/emotion/index.js';
import type { Emotion, EmotionInput } from '../src/emotion/index.js';

/* -----------------------------------------------------------------
 * EmotionMapper: per-emotion baseline tables
 * ----------------------------------------------------------------- */
describe('EmotionMapper', () => {
  const m = new EmotionMapper();

  it('has baselines for every emotion', () => {
    const all: Emotion[] = [
      'angry', 'calm', 'disgust', 'fear', 'happy', 'neutral',
      'sad', 'surprise', 'frustrated', 'confused', 'urgent',
    ];
    for (const e of all) {
      const p = m.baseParams(e);
      expect(p.speakingRate).toBeGreaterThan(0);
      expect(p.volume).toBeGreaterThan(0);
    }
  });

  it('baselines for negative emotions are already softened', () => {
    const angry = m.baseParams('angry');
    expect(angry.speakingRate).toBeLessThan(1.0);
    expect(angry.volume).toBeLessThanOrEqual(1.0);
    expect(angry.intonation).toBe('soft');
  });

  it('happy baseline is faster and higher-pitched', () => {
    const happy = m.baseParams('happy');
    expect(happy.speakingRate).toBeGreaterThan(1.0);
    expect(happy.pitch).toBeGreaterThan(0);
    expect(happy.intonation).toBe('dynamic');
  });

  it('styles include empathetic for negative emotions', () => {
    expect(m.baseStyles('angry')).toContain('empathetic');
    expect(m.baseStyles('sad')).toContain('empathetic');
    expect(m.baseStyles('frustrated')).toContain('empathetic');
  });

  it('overrides are merged on top of defaults', () => {
    const custom = new EmotionMapper({
      params: { happy: { speakingRate: 1.25 } },
    });
    expect(custom.baseParams('happy').speakingRate).toBe(1.25);
    // Other fields preserved.
    expect(custom.baseParams('happy').pitch).toBeGreaterThan(0);
  });
});

describe('emotionValence', () => {
  it('classifies happy/surprise as positive', () => {
    expect(emotionValence('happy')).toBe('positive');
    expect(emotionValence('surprise')).toBe('positive');
  });
  it('classifies anger/sad/fear/disgust/frustrated as negative', () => {
    expect(emotionValence('angry')).toBe('negative');
    expect(emotionValence('sad')).toBe('negative');
    expect(emotionValence('fear')).toBe('negative');
    expect(emotionValence('disgust')).toBe('negative');
    expect(emotionValence('frustrated')).toBe('negative');
  });
  it('classifies neutral/calm/confused/urgent as neutral', () => {
    expect(emotionValence('neutral')).toBe('neutral');
    expect(emotionValence('calm')).toBe('neutral');
    expect(emotionValence('confused')).toBe('neutral');
    expect(emotionValence('urgent')).toBe('neutral');
  });
});

describe('clampParams', () => {
  it('clamps rate and pitch into the safe band', () => {
    const out = clampParams({
      speakingRate: 5,
      pitch: 20,
      volume: 2,
      intonation: 'flat',
      pausePattern: 'natural',
    });
    expect(out.speakingRate).toBeLessThanOrEqual(1.3);
    expect(out.pitch).toBeLessThanOrEqual(4);
    expect(out.volume).toBeLessThanOrEqual(1.0);
  });
  it('lifts below-floor values', () => {
    const out = clampParams({
      speakingRate: 0.1,
      pitch: -50,
      volume: 0.1,
      intonation: 'soft',
      pausePattern: 'extended',
    });
    expect(out.speakingRate).toBeGreaterThanOrEqual(0.7);
    expect(out.pitch).toBeGreaterThanOrEqual(-4);
    expect(out.volume).toBeGreaterThanOrEqual(0.6);
  });
});

/* -----------------------------------------------------------------
 * StrategyResolver: strategy upgrade + confidence gate + streaks
 * ----------------------------------------------------------------- */
describe('StrategyResolver', () => {
  const mapper = new EmotionMapper();
  const r = new StrategyResolver(mapper);

  it('auto-upgrades mirror → soften for negative emotions', () => {
    const out = r.resolve({
      text: 'Let me help.',
      emotion: 'angry',
      confidence: 0.9,
      strategy: 'mirror',
    });
    expect(out.strategyApplied).toBe('soften');
    expect(out.styleTags).toContain('empathetic');
  });

  it('does NOT upgrade mirror for positive emotions', () => {
    const out = r.resolve({
      text: 'Glad to hear it!',
      emotion: 'happy',
      confidence: 0.9,
      strategy: 'mirror',
    });
    expect(out.strategyApplied).toBe('mirror');
  });

  it('honors explicit counterbalance even for negative emotions', () => {
    const out = r.resolve({
      text: 'Stay with me.',
      emotion: 'angry',
      confidence: 0.9,
      strategy: 'counterbalance',
    });
    expect(out.strategyApplied).toBe('counterbalance');
    // Counterbalance for negative → explicit low pitch, slow rate.
    expect(out.ttsParameters.pitch).toBeLessThanOrEqual(-1);
    expect(out.ttsParameters.speakingRate).toBeLessThanOrEqual(0.95);
  });

  it('gates low-confidence reads to neutral', () => {
    const out = r.resolve({
      text: 'OK.',
      emotion: 'angry',
      confidence: 0.2,
    });
    expect(out.effectiveEmotion).toBe('neutral');
    expect(out.rationale).toContain('confidence');
  });

  it('holds on a recent negative streak even if this turn is neutral', () => {
    const out = r.resolve({
      text: 'Go on.',
      emotion: 'neutral',
      confidence: 0.95,
      context: {
        previousEmotions: ['frustrated', 'angry', 'frustrated'],
      },
    });
    expect(['angry', 'frustrated']).toContain(out.effectiveEmotion);
    expect(out.strategyApplied).toBe('soften');
  });

  it('finalText always terminates with punctuation', () => {
    const out = r.resolve({
      text: 'no trailing period',
      emotion: 'neutral',
      confidence: 1,
    });
    expect(out.finalText.endsWith('.')).toBe(true);
  });

  it('soften blends toward neutral baseline, dampening extremes', () => {
    const out = r.resolve({
      text: 'Yay!',
      emotion: 'happy',
      confidence: 0.9,
      strategy: 'soften',
    });
    // soften on happy should pull rate and pitch toward neutral.
    const baseHappy = mapper.baseParams('happy');
    expect(out.ttsParameters.speakingRate).toBeLessThan(baseHappy.speakingRate);
    expect(out.ttsParameters.pitch).toBeLessThan(baseHappy.pitch);
  });

  it('never amplifies anger — rate stays ≤ 1.0 and volume ≤ 1.0', () => {
    for (const emo of ['angry', 'frustrated'] as Emotion[]) {
      for (const strat of ['mirror', 'soften', 'counterbalance'] as const) {
        const out = r.resolve({ text: 'Let me help.', emotion: emo, confidence: 0.9, strategy: strat });
        expect(out.ttsParameters.speakingRate).toBeLessThanOrEqual(1.0);
        expect(out.ttsParameters.volume).toBeLessThanOrEqual(1.0);
        expect(out.ttsParameters.intonation).not.toBe('dynamic');
      }
    }
  });

  it('disabling empathetic override lets mirror apply to negative', () => {
    const strict = new StrategyResolver(mapper, { empatheticMirroringOverride: false });
    const out = strict.resolve({
      text: 'ok',
      emotion: 'angry',
      confidence: 0.9,
      strategy: 'mirror',
    });
    expect(out.strategyApplied).toBe('mirror');
  });
});

/* -----------------------------------------------------------------
 * TtsAdapter: emotion parameters → engine directives + SSML
 * ----------------------------------------------------------------- */
describe('TtsAdapter', () => {
  const facade = new EmotionAdaptiveTts();

  it('emits playback rate + gain matching parameters', () => {
    const { output, directives } = facade.adapt({
      text: 'Hi there.',
      emotion: 'happy',
      confidence: 0.9,
    });
    expect(directives.playbackRate).toBeCloseTo(output.ttsParameters.speakingRate, 5);
    expect(directives.gain).toBeCloseTo(output.ttsParameters.volume, 5);
    expect(directives.pitchSemitones).toBe(output.ttsParameters.pitch);
  });

  it('extended pause pattern produces longer inter-chunk silence', () => {
    const { directives: calm } = facade.adapt({ text: 'I understand.', emotion: 'sad', confidence: 0.9 });
    const { directives: happy } = facade.adapt({ text: 'Got it.', emotion: 'happy', confidence: 0.9 });
    expect(calm.interChunkSilenceMs).toBeGreaterThan(happy.interChunkSilenceMs);
  });

  it('produces valid SSML with prosody and break tags', () => {
    const { directives } = facade.adapt({
      text: 'First sentence. Second sentence, here.',
      emotion: 'sad',
      confidence: 0.9,
    });
    expect(directives.ssml).toMatch(/^<speak>/);
    expect(directives.ssml).toMatch(/<\/speak>$/);
    expect(directives.ssml).toMatch(/<prosody\s/);
    expect(directives.ssml).toMatch(/<break\s+time="\d+ms"\/>/);
  });

  it('escapes XML special characters in SSML', () => {
    const adapter = new TtsAdapter();
    const out = facade.adapt({
      text: 'a < b & c > d',
      emotion: 'neutral',
      confidence: 0.9,
    }).output;
    const directives = adapter.toDirectives(out);
    expect(directives.ssml).toContain('&lt;');
    expect(directives.ssml).toContain('&gt;');
    expect(directives.ssml).toContain('&amp;');
  });

  it('includes style tags as a comment for SSML engines that ignore them', () => {
    const { directives } = facade.adapt({
      text: 'I hear you.',
      emotion: 'frustrated',
      confidence: 0.9,
    });
    expect(directives.ssml).toContain('style:');
    expect(directives.ssml).toContain('empathetic');
  });
});

/* -----------------------------------------------------------------
 * normalizeSerLabel: classifier label → Emotion union
 * ----------------------------------------------------------------- */
describe('normalizeSerLabel', () => {
  it('maps classifier prefixes', () => {
    expect(normalizeSerLabel('ANG')).toBe('angry');
    expect(normalizeSerLabel('angry')).toBe('angry');
    expect(normalizeSerLabel('CAL')).toBe('calm');
    expect(normalizeSerLabel('HAP')).toBe('happy');
    expect(normalizeSerLabel('happiness')).toBe('happy');
    expect(normalizeSerLabel('NEU')).toBe('neutral');
    expect(normalizeSerLabel('SAD')).toBe('sad');
    expect(normalizeSerLabel('SUR')).toBe('surprise');
    expect(normalizeSerLabel('FEA')).toBe('fear');
    expect(normalizeSerLabel('DIS')).toBe('disgust');
  });

  it('falls back to neutral on unknown labels', () => {
    expect(normalizeSerLabel('bored')).toBe('neutral');
    expect(normalizeSerLabel('')).toBe('neutral');
  });
});

/* -----------------------------------------------------------------
 * Audible-delta regression: directives must be materially different
 * from neutral, not just a 2-3% tweak that nobody can hear.
 * ----------------------------------------------------------------- */
describe('audible delta from neutral', () => {
  const f = new EmotionAdaptiveTts();
  const neutral = f.adapt({ text: 'ok.', emotion: 'neutral', confidence: 1 }).directives;

  const emotions: Emotion[] = [
    'angry', 'frustrated', 'sad', 'happy', 'surprise',
    'confused', 'urgent', 'calm',
  ];

  for (const emo of emotions) {
    it(`${emo} has an audible delta`, () => {
      const d = f.adapt({ text: 'ok.', emotion: emo, confidence: 0.9 }).directives;
      // At least ONE of rate / gain / interChunkSilence / pitch must
      // differ from neutral by a perceptually-meaningful amount.
      const rateDelta = Math.abs(d.playbackRate - neutral.playbackRate);
      const gainDelta = Math.abs(d.gain - neutral.gain);
      const pauseDelta = Math.abs(d.interChunkSilenceMs - neutral.interChunkSilenceMs);
      const pitchDelta = Math.abs(d.pitchSemitones - neutral.pitchSemitones);
      const audible =
        rateDelta >= 0.04 ||     // ≥4% rate change
        gainDelta >= 0.04 ||     // ≥4% volume
        pauseDelta >= 80 ||      // ≥80ms pause delta
        pitchDelta >= 1;         // ≥1 semitone
      if (!audible) {
        // Log what we actually got so failures are easy to debug.
        // eslint-disable-next-line no-console
        console.error(`${emo} directives too close to neutral:`, d, 'vs neutral:', neutral);
      }
      expect(audible).toBe(true);
    });
  }

  it('angry + soften preserves empathetic intention (not pulled all the way to neutral)', () => {
    // With the 30%-toward-neutral blend for negative valence, angry
    // should stay audibly slow/soft even after soften. If this ever
    // drifts back toward neutral, the empathetic-mirroring intent is
    // broken.
    const d = f.adapt({ text: 'ok.', emotion: 'angry', confidence: 0.9, strategy: 'mirror' }).directives;
    expect(d.playbackRate).toBeLessThanOrEqual(0.95);
    expect(d.gain).toBeLessThanOrEqual(0.95);
    expect(d.interChunkSilenceMs).toBeGreaterThanOrEqual(150);
  });
});

/* -----------------------------------------------------------------
 * Facade end-to-end
 * ----------------------------------------------------------------- */
describe('EmotionAdaptiveTts end-to-end', () => {
  const facade = new EmotionAdaptiveTts();

  function adapt(input: EmotionInput) {
    return facade.adapt(input);
  }

  it('frustrated input → calm empathetic output', () => {
    const { output, directives } = adapt({
      text: 'I understand, let me help you with that.',
      emotion: 'frustrated',
      confidence: 0.85,
    });
    expect(output.strategyApplied).toBe('soften');
    expect(output.styleTags).toContain('empathetic');
    expect(output.ttsParameters.intonation).toBe('soft');
    expect(directives.playbackRate).toBeLessThanOrEqual(1.0);
  });

  it('happy input → energetic but reasonable output', () => {
    const { output } = adapt({
      text: 'That\'s great to hear!',
      emotion: 'happy',
      confidence: 0.9,
    });
    expect(output.strategyApplied).toBe('mirror');
    expect(output.ttsParameters.speakingRate).toBeGreaterThanOrEqual(1.0);
    expect(output.ttsParameters.intonation).toBe('dynamic');
  });

  it('confused input → slower, clearer, soft intonation', () => {
    const { output } = adapt({
      text: 'Let me explain that again more clearly.',
      emotion: 'confused',
      confidence: 0.8,
    });
    expect(output.ttsParameters.speakingRate).toBeLessThanOrEqual(1.0);
    expect(output.ttsParameters.intonation).toBe('soft');
    expect(output.ttsParameters.pausePattern).toBe('extended');
  });
});
