import type { Logger } from '@oasis-echo/telemetry';
import type { DialogueState, RouterOutput } from '@oasis-echo/types';
import type { Reasoner } from '@oasis-echo/reasoning';
import { combinedSimilarity } from './postprocess/phrases.js';
import type { Router } from './router.js';
import { SentenceChunker } from './tts.js';

/**
 * Speculative execution of the router + reasoner on PARTIAL STT text
 * while the user is still speaking. When the user commits (`stt.final`),
 * we decide:
 *
 *   - HIT   → the final matches the partial closely enough; promote
 *             the already-computed/in-flight reply. First TTS chunk
 *             can fire within tens of milliseconds.
 *   - MISS  → final diverged from the partial. Abort the speculative
 *             reasoner and let the pipeline fall back to a fresh turn.
 *
 * Nothing speculative is ever broadcast to the client. All tts.chunk
 * / llm.token events only start flowing AFTER a successful commit
 * promotes the buffered work — so a mis-speculation is invisible.
 */

/** Committable speculation result — caller drains `sentences` into TTS. */
export type SpeculationHit = {
  kind: 'hit';
  routerOutput: RouterOutput;
  /** Async stream of completed sentences, already produced + any that
   *  arrive from the still-running reasoner. Ends when reasoner finishes
   *  or when the speculation is aborted. */
  sentences: AsyncIterable<string>;
  /** Resolves with the full agent text when the reasoner completes. */
  done: Promise<string>;
};

export type SpeculationMiss = {
  kind: 'miss';
  reason: 'not-found' | 'diverged' | 'aborted';
};

export type SpeculationCommitResult = SpeculationHit | SpeculationMiss;

export type SpeculationManagerOpts = {
  router: Router;
  reasoner: Reasoner;
  /** Called each time we need the current dialogue state for routing. */
  getState: () => DialogueState;
  /**
   * Minimum combined-similarity between the partial-at-speculation-start
   * and the committed final text for a HIT. Below this, we regenerate
   * on the real pipeline instead of risking a stale reply.
   *
   * Default 0.72 — STT tails often shift a single token between
   * partial and final (e.g. "doin" → "doing"), which drops combined
   * Levenshtein+Jaccard below 0.82. The client only fires `sendPartial`
   * on a stable debouncer buffer, so "user added a totally different
   * sentence mid-commit" is already rare.
   */
  similarityThreshold?: number;
  /**
   * Hard cap on how long `commit()` will wait for the router promise
   * to resolve before giving up and returning a miss. Protects against
   * cold-start timeouts — the first-ever SLM router call on a fresh
   * Ollama instance can hang for 10+ seconds before its internal
   * timeout fires, during which the client sits in silence. Falling
   * through to `pipeline.handleTurn` fast means the existing filler
   * pre-roll in `escalate()` runs within ~600ms of commit.
   * Default 1500ms.
   */
  commitRouterTimeoutMs?: number;
  /**
   * When a new partial update arrives for an existing speculation and
   * similarity to the old partial drops below this, we abort + restart
   * speculation.
   *
   * Default 0.78 — low enough to ignore normal STT tail wiggles
   * (`"help us"` ↔ `"helps"` scores ~0.82), high enough to catch
   * meaningful sentence restructures that invalidate an in-flight
   * reasoner stream. Previously 0.85, which fired restarts on every
   * tail correction and wasted compute on aborted reasoner calls.
   */
  restartThreshold?: number;
  logger?: Logger;
};

type Buffer = {
  partial: string;
  routerPromise: Promise<RouterOutput>;
  reasonerPromise: Promise<string> | null;
  abort: AbortController;
  /** Completed sentences ready for TTS. Pushed from the reasoner loop. */
  sentences: string[];
  /** Notify any async consumer that `sentences` or `done` advanced. */
  waiter: (() => void) | null;
  done: boolean;
  fullText: string;
  startedAt: number;
};

export class SpeculationManager {
  private readonly buffers = new Map<string, Buffer>();
  private readonly similarityThreshold: number;
  private readonly restartThreshold: number;
  private readonly commitRouterTimeoutMs: number;
  private readonly router: Router;
  private readonly reasoner: Reasoner;
  private readonly getState: () => DialogueState;
  private readonly logger: Logger | undefined;

  constructor(opts: SpeculationManagerOpts) {
    this.router = opts.router;
    this.reasoner = opts.reasoner;
    this.getState = opts.getState;
    this.similarityThreshold = opts.similarityThreshold ?? 0.72;
    this.restartThreshold = opts.restartThreshold ?? 0.78;
    this.commitRouterTimeoutMs = opts.commitRouterTimeoutMs ?? 1500;
    this.logger = opts.logger;
  }

  /** Kick off (or refresh) speculation for a turn. Non-blocking. */
  update(id: string, partial: string): void {
    const trimmed = partial.trim();
    if (!trimmed) return;
    const existing = this.buffers.get(id);
    if (existing) {
      // Prefix-extension fast path. If the new partial is the old
      // partial with more words appended (same utterance growing as
      // the user speaks), keep the in-flight reasoner running on its
      // original prompt and just record the extended text so the
      // commit-time similarity check sees the latest. This is what
      // makes "stream sendPartial on every interim" cheap — a 50-
      // word dictation causes 1 reasoner call, not 50 restarts.
      const oldNorm = norm(existing.partial);
      const newNorm = norm(trimmed);
      if (newNorm.startsWith(oldNorm)) {
        existing.partial = trimmed;
        return;
      }
      const sim = combinedSimilarity(oldNorm, newNorm);
      if (sim >= this.restartThreshold) {
        // Minor wiggle (e.g. STT tail correction) — keep speculating.
        existing.partial = trimmed;
        return;
      }
      // Diverged enough that the in-flight reasoner is probably wrong.
      this.logger?.info('speculation restart', {
        id,
        similarity: Number(sim.toFixed(2)),
      });
      this.abort(id);
    }
    const buf: Buffer = {
      partial: trimmed,
      // Placeholder; replaced immediately below.
      routerPromise: Promise.resolve({} as RouterOutput),
      reasonerPromise: null,
      abort: new AbortController(),
      sentences: [],
      waiter: null,
      done: false,
      fullText: '',
      startedAt: Date.now(),
    };
    this.buffers.set(id, buf);
    buf.routerPromise = this.startRouting(buf).catch((err) => {
      this.logger?.warn('speculation route failed', { id, error: String(err) });
      buf.done = true;
      buf.waiter?.();
      throw err;
    });
  }

  private async startRouting(buf: Buffer): Promise<RouterOutput> {
    const out = await this.router.route({ text: buf.partial, state: this.getState() });
    if (buf.abort.signal.aborted) return out;
    if (out.decision.kind === 'escalate') {
      buf.reasonerPromise = this.startReasoning(buf);
    } else if (out.decision.kind === 'local') {
      // Router already gave us the full reply — pre-chunk it.
      const reply = (out.decision.reply ?? '').trim();
      buf.fullText = reply;
      if (reply) {
        for (const s of splitIntoSentences(reply)) buf.sentences.push(s);
      }
      buf.done = true;
      buf.waiter?.();
    } else {
      // reflex decisions aren't produced by the router (pipeline handles
      // those inline) but be defensive.
      buf.done = true;
      buf.waiter?.();
    }
    return out;
  }

  private async startReasoning(buf: Buffer): Promise<string> {
    const chunker = new SentenceChunker();
    let text = '';
    try {
      for await (const ev of this.reasoner.stream({
        userText: buf.partial,
        state: this.getState(),
        signal: buf.abort.signal,
      })) {
        if (buf.abort.signal.aborted) break;
        if (ev.type === 'token') {
          text += ev.text;
          buf.fullText = text;
          for (const s of chunker.feed(ev.text)) {
            buf.sentences.push(s);
            buf.waiter?.();
          }
        }
      }
      const rest = chunker.flush();
      if (rest && rest.trim().length > 0) {
        buf.sentences.push(rest);
        buf.waiter?.();
      }
    } catch (err) {
      if (!buf.abort.signal.aborted) {
        this.logger?.warn('speculation reasoner failed', { error: String(err) });
      }
    }
    buf.done = true;
    buf.waiter?.();
    return text;
  }

  /**
   * Attempt to claim the speculation buffer for a committed turn.
   * Side effect: whether hit or miss, the entry is removed from the
   * manager; misses abort any in-flight reasoner.
   */
  async commit(id: string, finalText: string): Promise<SpeculationCommitResult> {
    const buf = this.buffers.get(id);
    if (!buf) return { kind: 'miss', reason: 'not-found' };
    this.buffers.delete(id);
    if (buf.abort.signal.aborted) return { kind: 'miss', reason: 'aborted' };

    // Wait for routing to resolve — but with a hard deadline. A cold
    // SLM router can hang 10+ seconds on first call; if it's not back
    // by `commitRouterTimeoutMs`, give up on speculation and let the
    // caller fall through to `pipeline.handleTurn`. That path's
    // existing filler logic bridges the wait, so the user hears
    // "Hmm." within ~600ms instead of sitting silent for 10 seconds.
    const timeoutSymbol = Symbol('router-timeout');
    const raced = await Promise.race<RouterOutput | typeof timeoutSymbol>([
      buf.routerPromise.catch((): RouterOutput => {
        // Promise already rejected — treat as a distinct "aborted" path.
        return { intent: 'unknown', confidence: 0, decision: { kind: 'local', intent: 'unknown' } };
      }),
      new Promise<typeof timeoutSymbol>((resolve) =>
        setTimeout(() => resolve(timeoutSymbol), this.commitRouterTimeoutMs),
      ),
    ]);
    if (raced === timeoutSymbol) {
      this.logger?.info('speculation commit miss (router slow)', {
        id,
        timeoutMs: this.commitRouterTimeoutMs,
      });
      buf.abort.abort();
      return { kind: 'miss', reason: 'diverged' };
    }
    const routerOutput = raced;

    const sim = combinedSimilarity(norm(buf.partial), norm(finalText.trim()));
    if (sim < this.similarityThreshold) {
      buf.abort.abort();
      this.logger?.info('speculation commit miss', {
        id,
        partial: buf.partial,
        finalText,
        similarity: Number(sim.toFixed(2)),
      });
      return { kind: 'miss', reason: 'diverged' };
    }

    this.logger?.info('speculation commit hit', {
      id,
      similarity: Number(sim.toFixed(2)),
      speculationMs: Date.now() - buf.startedAt,
      bufferedSentences: buf.sentences.length,
      reasoning: buf.reasonerPromise !== null,
      done: buf.done,
    });

    return {
      kind: 'hit',
      routerOutput,
      sentences: this.drainSentences(buf),
      done: buf.reasonerPromise ?? Promise.resolve(buf.fullText),
    };
  }

  /** Discard any in-flight speculation for this id. */
  abort(id: string): void {
    const buf = this.buffers.get(id);
    if (!buf) return;
    buf.abort.abort();
    buf.done = true;
    buf.waiter?.();
    this.buffers.delete(id);
  }

  /** Number of active speculations (for metrics / debug). */
  activeCount(): number {
    return this.buffers.size;
  }

  /**
   * Async iterator that yields every sentence already in the buffer
   * and then any that arrive from the still-running reasoner, in
   * arrival order. Returns when `buf.done` is true and the queue is
   * drained.
   */
  private drainSentences(buf: Buffer): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          async next(): Promise<IteratorResult<string>> {
            while (true) {
              if (buf.sentences.length > 0) {
                return { value: buf.sentences.shift()!, done: false };
              }
              if (buf.done) return { value: undefined, done: true };
              await new Promise<void>((resolve) => {
                buf.waiter = () => {
                  buf.waiter = null;
                  resolve();
                };
              });
            }
          },
        };
      },
    };
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Lightweight sentence splitter used for the local-reply case where
 *  the router hands back a complete string and we need to feed it to
 *  TTS one sentence at a time. */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
