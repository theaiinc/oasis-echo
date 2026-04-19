/**
 * TurnDebouncer: accumulate final-transcript fragments, commit the
 * whole utterance after sustained silence. Ported from the inline
 * logic in packages/app/src/index.html.
 *
 * Browser `SpeechRecognition` fires `isFinal` eagerly on short pauses,
 * so a single spoken sentence frequently fragments into 3-4 final
 * events. Naively POSTing `/turn` on each fragment splits one
 * utterance into multiple turns and the second fragment can land
 * mid-generation, triggering a barge-in against the reply to the
 * first fragment. Debouncing fixes both.
 *
 * Usage:
 *
 *   const deb = new TurnDebouncer({ onCommit: (text) => client.sendTurn({ text }) });
 *   recognition.onresult = (ev) => {
 *     // compute interim / final from ev.results ...
 *     if (interim) deb.onInterim(interim);
 *     if (final) deb.onFinal(final);
 *   };
 */

export type TurnDebouncerOpts = {
  /** Silence (ms) after the last final fragment before committing. Default 1200. */
  silenceMs?: number;
  /**
   * Multiplier applied to `silenceMs` when the buffered tail looks like
   * a mid-thought fragment (ends in "but", "and", "what if", …).
   * Default 2 — a user who just said "…but what if" almost certainly
   * isn't done talking.
   */
  incompleteTailMultiplier?: number;
  /** Override the incomplete-tail regex if you want a different policy. */
  incompleteTailRegex?: RegExp;
  /** Called when an utterance commits. */
  onCommit: (text: string) => void;
  /** Optional: called on every state change (for UI hints like "pausing..."). */
  onStateChange?: (state: DebouncerState) => void;
};

export type DebouncerState =
  | { kind: 'idle' }
  | { kind: 'listening'; preview: string }
  | { kind: 'pausing'; buffer: string; deadlineMs: number };

const DEFAULT_INCOMPLETE_TAIL =
  /(?:^|\s)(?:but|and|or|if|because|cause|cuz|so|when|while|as|though|although|yet|plus|like|with|for|to|of|at|what if|even if|only if|in case|what about|how about|the|a|an|my|your|his|her|their|our)\s*$/i;

export class TurnDebouncer {
  private readonly silenceMs: number;
  private readonly multiplier: number;
  private readonly incompleteTail: RegExp;
  private readonly onCommit: (text: string) => void;
  private readonly onStateChange?: (state: DebouncerState) => void;

  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadlineMs = 0;

  constructor(opts: TurnDebouncerOpts) {
    this.silenceMs = opts.silenceMs ?? 1200;
    this.multiplier = opts.incompleteTailMultiplier ?? 2;
    this.incompleteTail = opts.incompleteTailRegex ?? DEFAULT_INCOMPLETE_TAIL;
    this.onCommit = opts.onCommit;
    if (opts.onStateChange) this.onStateChange = opts.onStateChange;
  }

  /** User is still speaking — cancel any pending commit and emit a preview state. */
  onInterim(text: string): void {
    this.clearTimer();
    if (this.onStateChange) {
      const preview = (this.buffer + ' ' + text.trim()).trim();
      this.onStateChange({ kind: 'listening', preview });
    }
  }

  /** A final fragment arrived — append to the buffer and schedule commit. */
  onFinal(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.buffer = (this.buffer + ' ' + t).trim();
    this.scheduleCommit();
  }

  /** Force-commit right now, regardless of the timer. */
  flush(): void {
    this.clearTimer();
    this.commit();
  }

  /** Discard the buffered utterance without committing. */
  cancel(): void {
    this.clearTimer();
    this.buffer = '';
    if (this.onStateChange) this.onStateChange({ kind: 'idle' });
  }

  /** Current buffered text (for rendering a live preview). */
  getBuffer(): string {
    return this.buffer;
  }

  /** Ms remaining until auto-commit, or 0 if no timer is pending. */
  timeUntilCommit(): number {
    if (!this.timer) return 0;
    return Math.max(0, this.deadlineMs - performanceNow());
  }

  private scheduleCommit(): void {
    const tail = this.buffer.trim();
    if (!tail) return;
    const delay = this.incompleteTail.test(tail)
      ? this.silenceMs * this.multiplier
      : this.silenceMs;
    this.clearTimer();
    this.deadlineMs = performanceNow() + delay;
    this.timer = setTimeout(() => this.commit(), delay);
    if (this.onStateChange) {
      this.onStateChange({ kind: 'pausing', buffer: this.buffer, deadlineMs: this.deadlineMs });
    }
  }

  private commit(): void {
    const text = this.buffer.trim();
    this.buffer = '';
    this.timer = null;
    this.deadlineMs = 0;
    if (!text) {
      if (this.onStateChange) this.onStateChange({ kind: 'idle' });
      return;
    }
    if (this.onStateChange) this.onStateChange({ kind: 'idle' });
    this.onCommit(text);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.deadlineMs = 0;
    }
  }
}

function performanceNow(): number {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  if (p && typeof p.now === 'function') return p.now();
  return Date.now();
}
