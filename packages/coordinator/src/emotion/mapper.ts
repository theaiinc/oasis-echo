import type { Emotion, StyleTag, TtsParameters } from './types.js';

/**
 * Per-emotion baseline parameters. These are the "mirror honestly"
 * defaults — the strategy resolver may dampen or invert them for
 * negative emotions to avoid sounding aggressive.
 *
 * All values are chosen to stay within an audible-but-subtle band.
 * The spec's hard requirement: never amplify anger or sarcasm.
 */
const BASE_PARAMS: Record<Emotion, TtsParameters> = {
  // Positive / neutral. Magnitudes chosen so the delta from neutral is
  // CLEARLY audible — subtle 2-3% tweaks don't register perceptually
  // and defeat the point of the module.
  neutral:    { speakingRate: 1.00, pitch:  0, volume: 1.00, intonation: 'flat',    pausePattern: 'natural'  },
  calm:       { speakingRate: 0.92, pitch:  0, volume: 0.93, intonation: 'soft',    pausePattern: 'natural'  },
  happy:      { speakingRate: 1.14, pitch: +3, volume: 1.00, intonation: 'dynamic', pausePattern: 'short'    },
  surprise:   { speakingRate: 1.10, pitch: +2, volume: 1.00, intonation: 'dynamic', pausePattern: 'natural'  },
  // Negative. Already-softened empathetic baselines — the strategy
  // resolver's `soften` pass only pulls 30% toward neutral so the
  // empathetic flavor is preserved. We never amplify anger.
  angry:      { speakingRate: 0.85, pitch: -2, volume: 0.88, intonation: 'soft',    pausePattern: 'extended' },
  frustrated: { speakingRate: 0.87, pitch: -2, volume: 0.90, intonation: 'soft',    pausePattern: 'extended' },
  sad:        { speakingRate: 0.88, pitch: -2, volume: 0.92, intonation: 'soft',    pausePattern: 'extended' },
  fear:       { speakingRate: 0.92, pitch: -1, volume: 0.92, intonation: 'soft',    pausePattern: 'natural'  },
  disgust:    { speakingRate: 0.92, pitch: -1, volume: 0.92, intonation: 'soft',    pausePattern: 'natural'  },
  confused:   { speakingRate: 0.85, pitch:  0, volume: 1.00, intonation: 'soft',    pausePattern: 'extended' },
  urgent:     { speakingRate: 1.12, pitch: +1, volume: 1.00, intonation: 'flat',    pausePattern: 'short'    },
};

const BASE_STYLES: Record<Emotion, StyleTag[]> = {
  neutral:    [],
  calm:       ['calm'],
  happy:      ['cheerful', 'warm'],
  surprise:   ['curious'],
  angry:      ['empathetic', 'calm', 'patient'],
  frustrated: ['empathetic', 'patient', 'supportive'],
  sad:        ['empathetic', 'warm', 'supportive'],
  fear:       ['reassuring', 'calm'],
  disgust:    ['calm', 'patient'],
  confused:   ['patient', 'reassuring'],
  urgent:     ['focused'],
};

/**
 * Lookup table access. Cloning keeps callers from mutating shared state.
 * If callers want to override per-deployment, pass a custom `overrides`
 * map merged on top of BASE_PARAMS.
 */
export class EmotionMapper {
  private readonly params: Record<Emotion, TtsParameters>;
  private readonly styles: Record<Emotion, StyleTag[]>;

  constructor(overrides?: {
    params?: Partial<Record<Emotion, Partial<TtsParameters>>>;
    styles?: Partial<Record<Emotion, StyleTag[]>>;
  }) {
    this.params = {} as Record<Emotion, TtsParameters>;
    for (const [emo, p] of Object.entries(BASE_PARAMS) as Array<[Emotion, TtsParameters]>) {
      const o = overrides?.params?.[emo];
      this.params[emo] = { ...p, ...(o ?? {}) };
    }
    this.styles = {} as Record<Emotion, StyleTag[]>;
    for (const [emo, s] of Object.entries(BASE_STYLES) as Array<[Emotion, StyleTag[]]>) {
      this.styles[emo] = [...(overrides?.styles?.[emo] ?? s)];
    }
  }

  baseParams(emotion: Emotion): TtsParameters {
    return { ...this.params[emotion] };
  }

  baseStyles(emotion: Emotion): StyleTag[] {
    return [...this.styles[emotion]];
  }
}

/**
 * Classify emotions by valence. The strategy resolver uses this to
 * decide when to auto-override a `mirror` request with `soften`.
 */
export function emotionValence(e: Emotion): 'positive' | 'negative' | 'neutral' {
  switch (e) {
    case 'happy':
    case 'surprise':
      return 'positive';
    case 'angry':
    case 'frustrated':
    case 'sad':
    case 'fear':
    case 'disgust':
      return 'negative';
    case 'confused':
      // Neither positive nor harmful — treat as neutral-leaning so we
      // don't mis-classify curiosity as something to dampen.
      return 'neutral';
    case 'neutral':
    case 'calm':
    case 'urgent':
      return 'neutral';
  }
}

/** Clamp a parameter set into the safe delivery band. */
export function clampParams(p: TtsParameters): TtsParameters {
  return {
    speakingRate: clamp(p.speakingRate, 0.7, 1.3),
    pitch: clamp(p.pitch, -4, 4),
    volume: clamp(p.volume, 0.6, 1.0),
    intonation: p.intonation,
    pausePattern: p.pausePattern,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, v));
}
