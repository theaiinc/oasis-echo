import {
  EmotionMapper,
  clampParams,
  emotionValence,
} from './mapper.js';
import type {
  Emotion,
  EmotionInput,
  EmotionOutput,
  Strategy,
  StyleTag,
  TtsParameters,
} from './types.js';

export type StrategyResolverOpts = {
  /**
   * Top-1 confidence floor. Below this, we degrade `emotion` to
   * `neutral` regardless of what the classifier said — cheap guard
   * against noisy single-utterance reads. Default 0.5.
   */
  confidenceFloor?: number;
  /**
   * Temporal smoothing: if the last N emotions include ≥ this fraction
   * of negative reads, bump the effective emotion up a notch. Prevents
   * one lucky-neutral classification from flipping us back to mirror
   * mid-conversation. Default 2 of 3.
   */
  negativeStreakOf?: { n: number; of: number };
  /**
   * When the input asks for `mirror` on a strongly-negative emotion,
   * we silently upgrade to `soften` — empathetic mirroring, not copied
   * delivery. Setting this to false disables the override (not
   * recommended — see spec's "Make the user feel understood, not copied").
   * Default true.
   */
  empatheticMirroringOverride?: boolean;
};

/**
 * Core "what tone should the agent use" logic.
 *
 * Design principle (from the spec): make the user feel understood, not
 * copied. Full mirroring of frustration reads as aggressive; real
 * empathy acknowledges the feeling while staying calm. So:
 *
 *   - negative emotion + `mirror`  → auto-upgrade to `soften`
 *   - negative emotion + `counterbalance` → allowed (explicit stabilizing)
 *   - positive/neutral + any strategy → applied honestly
 *
 * The mapper supplies per-emotion base parameters. The resolver then
 * blends them with the chosen strategy's dampening coefficient and
 * clamps to the safe-delivery band.
 */
export class StrategyResolver {
  private readonly mapper: EmotionMapper;
  private readonly confidenceFloor: number;
  private readonly streak: { n: number; of: number };
  private readonly empathyOverride: boolean;

  constructor(mapper: EmotionMapper, opts: StrategyResolverOpts = {}) {
    this.mapper = mapper;
    this.confidenceFloor = opts.confidenceFloor ?? 0.5;
    this.streak = opts.negativeStreakOf ?? { n: 2, of: 3 };
    this.empathyOverride = opts.empatheticMirroringOverride ?? true;
  }

  resolve(input: EmotionInput): EmotionOutput {
    const requestedStrategy: Strategy = input.strategy ?? 'mirror';

    // Step 1: confidence gate. Low-confidence classifications drop to
    // neutral so we don't over-correct on noise.
    let effective: Emotion = input.emotion;
    let gatedByConfidence = false;
    if (input.confidence < this.confidenceFloor) {
      effective = 'neutral';
      gatedByConfidence = true;
    }

    // Step 2: temporal smoothing for negative streaks. If the last few
    // turns kept reading as negative, honor that even if this single
    // utterance came back positive — dataset noise shouldn't whiplash
    // the agent back to "cheerful" mid-frustration.
    const prev = input.context?.previousEmotions ?? [];
    const window = prev.slice(-this.streak.of);
    const negCount = window.filter((e) => emotionValence(e) === 'negative').length;
    if (
      !gatedByConfidence &&
      emotionValence(effective) !== 'negative' &&
      window.length >= this.streak.of &&
      negCount >= this.streak.n
    ) {
      // Stay in the strongest recent negative.
      effective = window
        .slice()
        .reverse()
        .find((e) => emotionValence(e) === 'negative') ?? effective;
    }

    // Step 3: strategy upgrade. Mirror-of-negative → soften.
    let strategy: Strategy = requestedStrategy;
    const valence = emotionValence(effective);
    if (this.empathyOverride && strategy === 'mirror' && valence === 'negative') {
      strategy = 'soften';
    }

    // Step 4: compute parameters.
    const base = this.mapper.baseParams(effective);
    const params = applyStrategy(base, strategy, valence);
    const clamped = clampParams(params);

    // Step 5: collect style tags.
    const styleTags = this.mapper.baseStyles(effective).slice();
    if (strategy === 'soften') pushUnique(styleTags, 'empathetic');
    if (strategy === 'counterbalance') pushUnique(styleTags, 'calm');

    // Step 6: finalize text. Minimal normalization — most text shaping
    // should happen upstream in the reasoner's prompt, not here.
    const finalText = normalizeText(input.text);

    const rationale = buildRationale({
      requestedEmotion: input.emotion,
      effective,
      requestedStrategy,
      appliedStrategy: strategy,
      gatedByConfidence,
      negativeStreak: negCount >= this.streak.n,
    });

    return {
      ttsParameters: clamped,
      styleTags,
      finalText,
      strategyApplied: strategy,
      effectiveEmotion: effective,
      rationale,
    };
  }
}

/**
 * Blend base parameters with a strategy. Strategies are coefficients
 * applied on top of the emotion's baseline:
 *
 *   - mirror        → 1.0× (use baseline as-is)
 *   - soften        → pull toward neutral: dampen extremes, add pauses
 *   - counterbalance→ move in the opposite direction of the emotion's
 *                     valence (agitated user → visibly calm agent)
 */
function applyStrategy(
  base: TtsParameters,
  strategy: Strategy,
  valence: 'positive' | 'negative' | 'neutral',
): TtsParameters {
  switch (strategy) {
    case 'mirror':
      return { ...base };
    case 'soften': {
      // Pull TOWARD a calm-neutral baseline. The pull is asymmetric:
      // a strongly-emotional baseline (positive OR negative) gets
      // partially dampened, but a negative baseline is already
      // empathetic, so we keep most of it — yanking fully to neutral
      // would make the agent sound cold in response to a frustrated
      // user. Positive baselines (happy) get more dampening so we
      // don't sound manic back at over-excited users.
      const neutralBaseline: TtsParameters = {
        speakingRate: 1.0,
        pitch: 0,
        volume: 1.0,
        intonation: 'soft',
        pausePattern: 'extended',
      };
      const toward = valence === 'negative' ? 0.3 : 0.6;
      return blend(base, neutralBaseline, toward);
    }
    case 'counterbalance': {
      if (valence === 'negative') {
        // User agitated → agent visibly calm: slower, lower pitch, softer.
        return {
          speakingRate: Math.min(base.speakingRate, 0.95),
          pitch: Math.min(base.pitch, -1),
          volume: Math.min(base.volume, 0.95),
          intonation: 'soft',
          pausePattern: 'extended',
        };
      }
      if (valence === 'positive') {
        // User overly excited → agent grounded: neutral baseline.
        return { speakingRate: 1.0, pitch: 0, volume: 1.0, intonation: 'flat', pausePattern: 'natural' };
      }
      return { ...base };
    }
  }
}

function blend(a: TtsParameters, b: TtsParameters, toward: number): TtsParameters {
  const mix = (x: number, y: number): number => x * (1 - toward) + y * toward;
  return {
    speakingRate: mix(a.speakingRate, b.speakingRate),
    pitch: mix(a.pitch, b.pitch),
    volume: mix(a.volume, b.volume),
    // Categorical fields: prefer the target when blending at ≥ 0.5.
    intonation: toward >= 0.5 ? b.intonation : a.intonation,
    pausePattern: toward >= 0.5 ? b.pausePattern : a.pausePattern,
  };
}

function normalizeText(text: string): string {
  // Collapse runs of whitespace, keep sentence punctuation, ensure we
  // terminate cleanly so TTS chunking behaves.
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return t;
  if (/[.!?…]$/.test(t)) return t;
  return t + '.';
}

function pushUnique<T>(arr: T[], v: T): void {
  if (!arr.includes(v)) arr.push(v);
}

function buildRationale(info: {
  requestedEmotion: Emotion;
  effective: Emotion;
  requestedStrategy: Strategy;
  appliedStrategy: Strategy;
  gatedByConfidence: boolean;
  negativeStreak: boolean;
}): string {
  const parts: string[] = [];
  if (info.gatedByConfidence) {
    parts.push(`confidence below floor → neutral (requested ${info.requestedEmotion})`);
  } else if (info.effective !== info.requestedEmotion) {
    parts.push(`negative streak → held on ${info.effective}`);
  } else {
    parts.push(`emotion=${info.effective}`);
  }
  if (info.appliedStrategy !== info.requestedStrategy) {
    parts.push(`strategy=${info.requestedStrategy}→${info.appliedStrategy} (empathetic override)`);
  } else {
    parts.push(`strategy=${info.appliedStrategy}`);
  }
  return parts.join('; ');
}
