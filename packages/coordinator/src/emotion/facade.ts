import { TtsAdapter } from './adapter.js';
import { EmotionMapper } from './mapper.js';
import { StrategyResolver, type StrategyResolverOpts } from './strategy.js';
import type {
  Emotion,
  EmotionInput,
  EmotionOutput,
  TtsDirectives,
} from './types.js';

export type EmotionAdaptiveTtsOpts = {
  mapperOverrides?: ConstructorParameters<typeof EmotionMapper>[0];
  strategyOpts?: StrategyResolverOpts;
};

export type AdaptedReply = {
  output: EmotionOutput;
  directives: TtsDirectives;
};

/**
 * Top-level facade: construct once, call `adapt(input)` per agent
 * reply. Returns both the structured `EmotionOutput` (for logging
 * / telemetry / style-tag-aware engines) and the engine-neutral
 * `TtsDirectives` ready to pass to the active TTS backend.
 */
export class EmotionAdaptiveTts {
  private readonly mapper: EmotionMapper;
  private readonly resolver: StrategyResolver;
  private readonly adapter: TtsAdapter;

  constructor(opts: EmotionAdaptiveTtsOpts = {}) {
    this.mapper = new EmotionMapper(opts.mapperOverrides);
    this.resolver = new StrategyResolver(this.mapper, opts.strategyOpts);
    this.adapter = new TtsAdapter();
  }

  adapt(input: EmotionInput): AdaptedReply {
    const output = this.resolver.resolve(input);
    const directives = this.adapter.toDirectives(output);
    return { output, directives };
  }
}

/** Default singleton when callers don't need custom config. */
let defaultInstance: EmotionAdaptiveTts | null = null;
export function defaultEmotionAdapter(): EmotionAdaptiveTts {
  if (!defaultInstance) defaultInstance = new EmotionAdaptiveTts();
  return defaultInstance;
}

/**
 * Map the 8-class SER classifier output label to the Emotion union.
 * Classifier labels vary between models (uppercase, mixed, etc.), so
 * we normalize defensively.
 */
export function normalizeSerLabel(label: string): Emotion {
  const l = label.trim().toLowerCase();
  if (l.startsWith('ang')) return 'angry';
  if (l.startsWith('cal')) return 'calm';
  if (l.startsWith('dis')) return 'disgust';
  if (l.startsWith('fea')) return 'fear';
  if (l.startsWith('hap') || l === 'happiness') return 'happy';
  if (l.startsWith('neu')) return 'neutral';
  if (l.startsWith('sad')) return 'sad';
  if (l.startsWith('sur')) return 'surprise';
  return 'neutral';
}
