/**
 * Emotion-Adaptive TTS types. The module takes a detected user emotion
 * plus the agent's reply text and returns TTS parameters shaped to
 * make the reply feel emotionally aware without *copying* the user —
 * i.e. the user frustrated should not make the agent sound frustrated,
 * it should make the agent sound empathetic and calm.
 */

/**
 * Emotion labels. Superset of the SER classifier's 8 output classes
 * (angry / calm / disgust / fear / happy / neutral / sad / surprise) plus
 * a few conversational states that can be derived from other signals
 * (text patterns, speech rate, context) if the caller supplies them.
 */
export type Emotion =
  | 'angry'
  | 'calm'
  | 'disgust'
  | 'fear'
  | 'happy'
  | 'neutral'
  | 'sad'
  | 'surprise'
  | 'frustrated'
  | 'confused'
  | 'urgent';

/** Response-shaping strategy. */
export type Strategy = 'mirror' | 'soften' | 'counterbalance';

export type InteractionState = 'ongoing' | 'new' | 'interrupted';

export type Intonation = 'soft' | 'dynamic' | 'flat';
export type PausePattern = 'short' | 'natural' | 'extended';

export type StyleTag =
  | 'empathetic'
  | 'calm'
  | 'cheerful'
  | 'reassuring'
  | 'curious'
  | 'focused'
  | 'supportive'
  | 'warm'
  | 'patient';

export type EmotionInput = {
  /** Agent reply text the TTS engine will speak. */
  text: string;
  /** Detected user emotion driving the adaptation. */
  emotion: Emotion;
  /** Classifier confidence 0..1. Low confidence → softer adaptation. */
  confidence: number;
  /** Requested strategy. Defaults to `mirror`. Overridden for strong negative. */
  strategy?: Strategy;
  context?: {
    previousEmotions?: Emotion[];
    interactionState?: InteractionState;
  };
};

export type TtsParameters = {
  /** 1.0 = normal. <1 slower, >1 faster. Clamp [0.7, 1.3]. */
  speakingRate: number;
  /** Semitones relative to the voice's default. Clamp [-4, +4]. */
  pitch: number;
  /** 0..1, linear gain applied to PCM or passed through as SSML volume. */
  volume: number;
  intonation: Intonation;
  pausePattern: PausePattern;
};

export type EmotionOutput = {
  /** Parameters the TTS adapter will apply (engine-specific). */
  ttsParameters: TtsParameters;
  /** Style tags for engines that support them (Azure, ElevenLabs, etc.). */
  styleTags: StyleTag[];
  /** Possibly tweaked text for more natural delivery. */
  finalText: string;
  /** Which strategy actually drove the adaptation (may differ from input). */
  strategyApplied: Strategy;
  /** The emotion actually used after confidence gating. */
  effectiveEmotion: Emotion;
  /** One-line explanation for logs/telemetry. */
  rationale: string;
};

/**
 * Engine-specific directives produced by the TTSAdapter. Kokoro has no
 * native SSML; we express rate / volume / pause as numeric directives
 * the client applies at playback time (playbackRate, gainNode, extra
 * silence gaps between chunks). SSML engines get a rendered `<speak>`
 * fragment instead.
 */
export type TtsDirectives = {
  /** Playback-rate multiplier. 1.0 default. */
  playbackRate: number;
  /** Linear gain 0..1. */
  gain: number;
  /** Milliseconds of silence to insert between sentence chunks. */
  interChunkSilenceMs: number;
  /** Pitch shift in semitones for engines that support it. */
  pitchSemitones: number;
  /** SSML string ready to hand to an SSML-capable engine. */
  ssml: string;
  /** Preferred voice preset name (engine-specific, optional). */
  voiceHint?: string;
};
