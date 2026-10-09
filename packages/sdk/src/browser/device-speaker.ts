/**
 * The device's own voice (Web Speech `speechSynthesis`), for calls where the server
 * sends the agent's words as text rather than audio (a plan with `voice: 'device'`).
 *
 * Same shape as AudioPlayer as VoiceSession uses it: queue per chunk, `activeCount`,
 * `stopAll()`, and `onEnd` once everything queued has been said.
 */

export type DeviceSpeakerOpts = {
  onEnd?: () => void;
  /** Override for tests or other runtimes. Default: window.speechSynthesis. */
  synth?: SpeechSynthesis;
  /** Override for tests. Default: window.SpeechSynthesisUtterance. */
  Utterance?: typeof SpeechSynthesisUtterance;
};

export class DeviceSpeaker {
  private readonly synth: SpeechSynthesis | null;
  private readonly Utterance: typeof SpeechSynthesisUtterance | null;
  private readonly onEnd?: () => void;
  private readonly pending = new Set<SpeechSynthesisUtterance>();
  private volume = 1;

  constructor(opts: DeviceSpeakerOpts = {}) {
    const w = typeof window === 'undefined' ? null : (window as unknown as { speechSynthesis?: SpeechSynthesis; SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance });
    this.synth = opts.synth ?? w?.speechSynthesis ?? null;
    this.Utterance = opts.Utterance ?? w?.SpeechSynthesisUtterance ?? null;
    if (opts.onEnd) this.onEnd = opts.onEnd;
  }

  static isSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  /** Speaker on/off (the call's speaker button). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
  }

  /** Queue this text in the language's best voice. */
  speak(text: string, lang: string): void {
    const t = text.trim();
    if (!t || !this.synth || !this.Utterance) return;
    const u = new this.Utterance(t);
    u.lang = lang;
    const voice = pickVoice(this.synth.getVoices(), lang);
    if (voice) u.voice = voice;
    u.volume = this.volume;
    const done = () => {
      if (!this.pending.delete(u)) return;
      if (this.pending.size === 0) this.onEnd?.();
    };
    u.onend = done;
    u.onerror = done;
    this.pending.add(u);
    this.synth.speak(u);
  }

  stopAll(): void {
    this.pending.clear();
    this.synth?.cancel();
  }

  get activeCount(): number {
    return this.pending.size;
  }
}

/**
 * The voice for a language: the exact locale before the language alone, then the
 * better-sounding kinds (network, natural, premium, enhanced) before the rest, and
 * female voices before others where the name says (Echo's voice is a woman's).
 */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  const want = lang.toLowerCase().replace('_', '-');
  const base = want.split('-')[0]!;
  const score = (v: SpeechSynthesisVoice): number => {
    const l = v.lang.toLowerCase().replace('_', '-');
    if (l !== want && l.split('-')[0] !== base) return -1;
    const n = v.name.toLowerCase();
    let s = l === want ? 100 : 50;
    if (/natural|neural|premium|enhanced|online|google/.test(n)) s += 20;
    if (!v.localService) s += 5;
    if (/female|linh|an\b|samantha|ava|allison|zira|aria|jenny|nữ/.test(n)) s += 10;
    if (/\bmale\b|nam\b/.test(n)) s -= 5;
    if (v.default) s += 1;
    return s;
  };
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = score(v);
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return bestScore >= 0 ? best : null;
}
