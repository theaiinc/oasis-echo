import type { EmotionOutput, TtsDirectives, TtsParameters } from './types.js';

/**
 * TTSAdapter turns abstract emotion parameters into engine-specific
 * directives. Two output shapes:
 *
 *   - numeric directives for Kokoro (no SSML): applied at playback
 *     time in the browser via `playbackRate`, `GainNode`, and extra
 *     silence gaps between sentence chunks.
 *   - SSML `<speak>` fragment for SSML-capable engines (Azure, Google,
 *     Polly, ElevenLabs, etc.). The client can pass this straight
 *     through if we swap TTS backend.
 *
 * Both are produced in one call so callers don't care which engine is
 * active at the adapter layer.
 */
export class TtsAdapter {
  toDirectives(out: EmotionOutput): TtsDirectives {
    const p = out.ttsParameters;
    return {
      playbackRate: p.speakingRate,
      gain: p.volume,
      interChunkSilenceMs: pauseMs(p.pausePattern),
      pitchSemitones: p.pitch,
      ssml: renderSsml(out.finalText, p, out.styleTags),
    };
  }
}

function pauseMs(pattern: TtsParameters['pausePattern']): number {
  // Inter-chunk silence is ADDITIVE on each Kokoro chunk, which tends
  // to be one-per-sentence. 280ms felt choppy in practice across
  // multi-sentence replies (cumulative 1s+ of inserted silence), so
  // we cap at 180ms for the "extended" empathetic pattern — still
  // audibly slower without breaking flow.
  switch (pattern) {
    case 'short':
      return 30;
    case 'natural':
      return 100;
    case 'extended':
      return 180;
  }
}

/**
 * Build an SSML `<speak>` fragment. We emit `<prosody>` for rate/pitch/
 * volume and `<break>` tags at sentence boundaries sized by pause
 * pattern. Style tags go on `<mstts:express-as>` (Azure) inside a
 * comment so engines that don't understand it ignore cleanly.
 */
function renderSsml(
  text: string,
  p: TtsParameters,
  styleTags: readonly string[],
): string {
  const rate = formatPercent(p.speakingRate);
  const pitch = formatSemitones(p.pitch);
  const volume = formatVolume(p.volume);
  const breakMs = pauseMs(p.pausePattern);
  const paced = insertBreaks(text, breakMs);
  const body = `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${paced}</prosody>`;
  const styled = styleTags.length > 0
    ? `<!-- style: ${styleTags.join(', ')} -->${body}`
    : body;
  return `<speak>${styled}</speak>`;
}

/** 1.00 → "100%"; 0.92 → "92%". */
function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatSemitones(semis: number): string {
  if (semis === 0) return '+0st';
  return `${semis > 0 ? '+' : ''}${semis}st`;
}

function formatVolume(v: number): string {
  // Azure-compatible range: silent / x-soft / soft / medium / loud / x-loud.
  if (v < 0.5) return 'soft';
  if (v < 0.85) return 'medium';
  if (v < 0.98) return 'medium';
  return 'default';
}

/**
 * Insert `<break time="Xms"/>` at sentence boundaries so the engine
 * emits the extended pauses we ask for. Also treat commas + ellipses
 * as half-strength pause points for naturalness.
 */
function insertBreaks(text: string, ms: number): string {
  const escaped = escapeXml(text);
  // Sentence-end pause.
  let out = escaped.replace(/([.!?…])(\s+|$)/g, (_m, punct, rest) => {
    return `${punct}<break time="${ms}ms"/>${rest}`;
  });
  // Comma pause — half as long.
  const half = Math.max(20, Math.round(ms / 2));
  out = out.replace(/,(\s+)/g, (_m, rest) => `,<break time="${half}ms"/>${rest}`);
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
