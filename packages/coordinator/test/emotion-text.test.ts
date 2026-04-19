import { describe, expect, it } from 'vitest';
import { detectEmotionFromText } from '../src/emotion/text.js';

describe('detectEmotionFromText', () => {
  it('returns null for empty / whitespace input', () => {
    expect(detectEmotionFromText('')).toBeNull();
    expect(detectEmotionFromText('   ')).toBeNull();
  });

  it('returns null when no rule matches', () => {
    expect(detectEmotionFromText('the weather is nice today')).toBeNull();
    expect(detectEmotionFromText('please book a flight to Tokyo')).toBeNull();
  });

  it('detects frustration cues', () => {
    const r = detectEmotionFromText("this is ridiculous, it doesn't work");
    expect(r?.emotion).toBe('frustrated');
    expect(r?.confidence).toBeGreaterThan(0.8);
    expect(r?.matched.length).toBeGreaterThan(0);
  });

  it('detects sadness cues', () => {
    const r = detectEmotionFromText("I'm feeling really down and sad today");
    expect(r?.emotion).toBe('sad');
  });

  it('detects confusion cues', () => {
    const r = detectEmotionFromText("I don't understand what you mean");
    expect(r?.emotion).toBe('confused');
  });

  it('detects urgency cues', () => {
    expect(detectEmotionFromText('I need this asap')?.emotion).toBe('urgent');
    expect(detectEmotionFromText('this is an emergency')?.emotion).toBe('urgent');
    expect(detectEmotionFromText('please hurry')?.emotion).toBe('urgent');
    expect(detectEmotionFromText('we need it right now')?.emotion).toBe('urgent');
  });

  it('does NOT fire urgent on benign "right now" conversational filler', () => {
    // Regression for the log capture where "I'm right now trying to
    // understand" got classified as urgent and made the agent sound
    // like it was on fast-forward.
    expect(detectEmotionFromText("I'm right now trying to understand it")).toBeNull();
    expect(detectEmotionFromText('right now it feels like a lot')).toBeNull();
    expect(detectEmotionFromText('quickly looked it up')).toBeNull();
    expect(detectEmotionFromText('immediately regretted it')).toBeNull();
  });

  it('detects surprise cues', () => {
    expect(detectEmotionFromText('wow, no way!')?.emotion).toBe('surprise');
    expect(detectEmotionFromText('are you serious')?.emotion).toBe('surprise');
  });

  it('detects happiness cues (lower-weight — acoustic usually wins)', () => {
    const r = detectEmotionFromText("I'm so excited, can't wait!");
    expect(r?.emotion).toBe('happy');
  });

  it('boosts confidence when multiple rules match for the same emotion', () => {
    const weak = detectEmotionFromText('this is frustrating');
    const strong = detectEmotionFromText(
      "this is so frustrating, completely useless, doesn't work",
    );
    expect(strong?.emotion).toBe('frustrated');
    expect(weak?.emotion).toBe('frustrated');
    expect((strong?.confidence ?? 0)).toBeGreaterThan(weak?.confidence ?? 0);
  });

  it('prefers the higher-weighted match when multiple emotions could fire', () => {
    // Contains both sad + confused cues; highest-weight wins.
    const r = detectEmotionFromText("I'm sad and I don't understand what happened");
    expect(['sad', 'confused']).toContain(r?.emotion);
  });

  it('does not misfire on neutral questions', () => {
    expect(detectEmotionFromText('what time is it')).toBeNull();
    expect(detectEmotionFromText('can you help me with a recipe')).toBeNull();
  });
});
