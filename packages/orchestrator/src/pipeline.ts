import { reflexClassify } from '@oasis-echo/reflex';
import {
  DialogueStateStore,
  Guardrail,
  LastTurnsSummarizer,
  SentenceChunker,
  type Router,
  type StreamingTts,
  type Summarizer,
} from '@oasis-echo/coordinator';
import type { Reasoner } from '@oasis-echo/reasoning';
import type { Logger, Metrics, Tracer } from '@oasis-echo/telemetry';
import type { Intent, RouterOutput, Turn } from '@oasis-echo/types';
import { BargeInArbiter } from './bargein-arbiter.js';
import { EventBus } from './event-bus.js';
import { pickApology, pickContinuationFiller, pickFirstFiller } from './filler.js';

export type PipelineOpts = {
  sessionId: string;
  router: Router;
  reasoner: Reasoner;
  tts: StreamingTts;
  summarizer?: Summarizer;
  guardrail?: Guardrail;
  bus?: EventBus;
  logger?: Logger;
  metrics?: Metrics;
  tracer?: Tracer;
  summarizeEveryNTurns?: number;
};

/**
 * The overlapping-execution pipeline described in SAD §5.
 *
 *   user text ─┬─ reflex ─▶ immediate TTS (if matched)
 *              ├─ router  ─▶ local reply ─▶ TTS
 *              └─ router  ─▶ escalate ─▶ [filler TTS] ∥ [cloud LLM]
 *                                                 └─▶ TTS (sentence-chunked)
 *
 * Barge-in: if the bus emits `bargein` while a turn is speaking, the
 * arbiter aborts the signal, flushing downstream producers via
 * AbortSignal propagation.
 */
export class Pipeline {
  readonly bus: EventBus;
  readonly state: DialogueStateStore;
  readonly arbiter: BargeInArbiter;

  private readonly router: Router;
  private readonly reasoner: Reasoner;
  private readonly tts: StreamingTts;
  private readonly summarizer: Summarizer;
  private readonly guardrail: Guardrail;
  private readonly logger: Logger | undefined;
  private readonly metrics: Metrics | undefined;
  private readonly tracer: Tracer | undefined;
  private readonly summarizeEveryNTurns: number;
  private turnCounter = 0;
  /**
   * Rolling set of recently-used filler phrases, scoped to the whole
   * pipeline instance. Bounded to the last ~12 phrases; older ones
   * age out so eventually every phrase becomes fair game again.
   */
  private readonly recentFillers: string[] = [];
  private readonly recentFillerCap = 12;
  private readonly recentApologies: string[] = [];
  /**
   * True when the user barge-in'd an escalated agent response. Consumed
   * at the start of the NEXT turn so the agent can apologize — this is
   * the Sesame-style "sorry, please go ahead" beat when we cut the
   * user off in a mid-utterance pause.
   */
  private pendingApology = false;
  /**
   * Exponential moving average of TTFT (time to first token) from the
   * reasoner, used to forecast the next turn's wait and shape filler
   * pacing: longer expected wait → slower TTS rate (sounds more
   * hesitant, like a human who isn't sure yet).
   */
  private ttftEmaMs = 0;

  constructor(opts: PipelineOpts) {
    this.bus = opts.bus ?? new EventBus();
    this.state = new DialogueStateStore({ sessionId: opts.sessionId });
    this.arbiter = new BargeInArbiter(this.bus, {
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.metrics ? { metrics: opts.metrics } : {}),
    });
    this.router = opts.router;
    this.reasoner = opts.reasoner;
    this.tts = opts.tts;
    this.summarizer = opts.summarizer ?? new LastTurnsSummarizer();
    this.guardrail = opts.guardrail ?? new Guardrail();
    this.logger = opts.logger;
    this.metrics = opts.metrics;
    this.tracer = opts.tracer;
    this.summarizeEveryNTurns = opts.summarizeEveryNTurns ?? 5;
  }

  /**
   * Process a single completed user utterance. Returns the final turn
   * record once TTS has finished (or was interrupted). Callers may
   * pass a pre-assigned `turnId` when they've already emitted
   * transcript events under that id; the pipeline will reuse it so
   * every downstream event lines up with the same turn.
   */
  async handleTurn(userText: string, opts: { turnId?: string } = {}): Promise<Turn> {
    this.turnCounter++;
    const turnId = opts.turnId ?? `t${this.turnCounter}-${Date.now().toString(36)}`;
    const startedAtMs = Date.now();
    const turnSpan = this.tracer?.start('turn', undefined, { turnId });

    // Reflex short-circuit
    const reflex = reflexClassify(userText);
    if (reflex) {
      const turn = await this.speakLocal(turnId, userText, reflex, 'reflex', startedAtMs);
      this.pendingApology = turn.interrupted && turn.tier !== 'reflex';
      this.state.applyIntent(turn.intent ?? 'unknown');
      this.state.recordTurn(turn);
      if (turnSpan) this.tracer?.end(turnSpan, { tier: 'reflex', intent: turn.intent });
      await this.bus.emit({ type: 'turn.complete', turn });
      return turn;
    }

    // Coordinator routing
    const routeSpan = this.tracer?.start('route', turnSpan);
    let output: RouterOutput = await this.router.route({ text: userText, state: this.state.snapshot() });
    if (routeSpan) this.tracer?.end(routeSpan, { intent: output.intent, kind: output.decision.kind });

    // Guardrail check
    const guard = this.guardrail.check(output);
    if (!guard.ok) {
      this.logger?.warn('guardrail rejected', { reason: guard.reason });
      this.metrics?.inc('guardrail_fallback_total', { reason: guard.reason });
      output = guard.fallback;
    }

    await this.bus.emit({
      type: 'route.decision',
      turnId,
      decision: output.decision,
      atMs: Date.now(),
    });

    let turn: Turn;
    if (output.decision.kind === 'local') {
      turn = await this.speakLocal(turnId, userText, output, 'local', startedAtMs);
    } else {
      turn = await this.escalate(turnId, userText, output, startedAtMs);
    }

    // If the agent got barge-in'd mid-response, apologize at the start
    // of the next turn. Skip tracking when the just-finished turn was
    // itself a reflex (too short to feel like a real interruption).
    this.pendingApology = turn.interrupted && turn.tier !== 'reflex';

    this.state.applyIntent(turn.intent ?? 'unknown');
    this.state.recordTurn(turn);

    // Rolling summarization every N turns
    if (this.turnCounter % this.summarizeEveryNTurns === 0) {
      try {
        const snapshot = this.state.snapshot();
        const summary = await this.summarizer.summarize(snapshot.turns, snapshot.summary);
        this.state.setSummary(summary);
      } catch (err) {
        this.logger?.warn('summarizer failed', { error: String(err) });
      }
    }

    if (turnSpan) this.tracer?.end(turnSpan, { tier: turn.tier, intent: turn.intent });
    await this.bus.emit({ type: 'turn.complete', turn });
    return turn;
  }

  /**
   * External caller triggers a barge-in (e.g., the reflex VAD saw the
   * user start talking while the agent was speaking).
   */
  async bargeIn(): Promise<boolean> {
    return this.arbiter.bargeIn(Date.now());
  }

  private async speakLocal(
    turnId: string,
    userText: string,
    output: RouterOutput,
    tier: 'reflex' | 'local',
    startedAtMs: number,
  ): Promise<Turn> {
    const reply = (output.decision.kind === 'local' || output.decision.kind === 'reflex')
      ? output.decision.reply ?? ''
      : '';
    const { spoken, interrupted } = await this.playText(turnId, reply);
    const endedAtMs = Date.now();
    this.metrics?.observe('ttfa_ms', endedAtMs - startedAtMs, { tier });
    this.metrics?.inc('turns_total', { tier });
    return {
      id: turnId,
      startedAtMs,
      endedAtMs,
      userText,
      intent: output.intent as Intent,
      agentText: spoken,
      tier,
      interrupted,
    };
  }

  private async escalate(
    turnId: string,
    userText: string,
    output: RouterOutput,
    startedAtMs: number,
  ): Promise<Turn> {
    if (output.decision.kind !== 'escalate') throw new Error('escalate called with non-escalate decision');

    const fillerReason = output.decision.reason;
    const recentSet = new Set(this.recentFillers);
    const fillerText =
      output.decision.filler ?? pickFirstFiller(recentSet);

    // Begin turn with arbiter; signal propagates to TTS and LLM
    const signal = this.arbiter.beginTurn(turnId, () => {});

    let agentText = '';
    let interrupted = false;

    try {
      await this.bus.emit({ type: 'tts.start', turnId, atMs: Date.now() });

      // If the agent got cut off mid-reply last turn, open with a
      // quick apology so the user knows we noticed we interrupted them.
      await this.maybeApologize(turnId, signal);

      // Stream tokens from the reasoner in the background and pipe them
      // through a sentence chunker. Sentences are pushed onto a queue
      // so the downstream TTS loop can synthesize each one as soon as
      // it's ready — no waiting for the full reply.
      const firstTokenState = { atMs: 0 };
      const chunker = new SentenceChunker();
      const sentenceQueue: string[] = [];
      let streamDone = false;
      let fullText = '';

      const tokensPromise = (async () => {
        try {
          for await (const ev of this.reasoner.stream({
            userText,
            state: this.state.snapshot(),
            signal,
          })) {
            if (signal.aborted) break;
            if (ev.type === 'token') {
              if (firstTokenState.atMs === 0) {
                firstTokenState.atMs = Date.now();
                this.recordTtft(firstTokenState.atMs - startedAtMs);
              }
              fullText += ev.text;
              await this.bus.emit({ type: 'llm.token', turnId, token: ev.text, atMs: Date.now() });
              for (const sentence of chunker.feed(ev.text)) sentenceQueue.push(sentence);
            } else if (ev.type === 'done') {
              const rest = chunker.flush();
              if (rest && rest.trim().length > 0) sentenceQueue.push(rest);
              await this.bus.emit({ type: 'llm.done', turnId, atMs: Date.now() });
              this.metrics?.inc('llm_tokens_out_total', {}, ev.outputTokens);
              this.metrics?.inc('llm_tokens_in_total', {}, ev.inputTokens);
            }
          }
        } catch (err) {
          if (!signal.aborted) throw err;
        }
        streamDone = true;
      })();

      // Race first-SENTENCE vs the filler threshold. We need a full
      // sentence to start synthesizing the reply, not just the first
      // token, so wait for sentenceQueue to actually have something.
      // If the model is fast enough that a sentence lands before the
      // threshold, we skip the filler entirely.
      const FILLER_THRESHOLD_MS = 600;
      const { fillerSpeed, maxFillers } = this.fillerStrategy();
      await Promise.race([
        (async () => {
          while (sentenceQueue.length === 0 && !signal.aborted && !streamDone) {
            await sleep(20);
          }
        })(),
        sleep(FILLER_THRESHOLD_MS),
      ]);

      // Play up to maxFillers while tokens still haven't arrived.
      //   Iteration 0: short "first-beat" filler ("Hmm.") for snappy feedback.
      //   Iteration 1+: longer CHAINED continuation (two fresh pool entries
      //                 joined into a single TTS call) so prosody flows as
      //                 one natural thought. The `usedFillers` set prevents
      //                 the same phrase appearing twice in one turn.
      const usedFillers = new Set<string>();
      if (fillerText) {
        usedFillers.add(fillerText);
        this.trackRecentFiller(fillerText);
      }
      let fillersPlayed = 0;
      // Keep filling while we don't yet have a complete sentence to
      // synthesize. First-token alone isn't enough — Gemma can emit
      // the first token at 700ms but take another 2-4s to complete
      // the sentence, and we can't synthesize a fragment. So we wait
      // for sentenceQueue to have something real.
      while (
        sentenceQueue.length === 0 &&
        !signal.aborted &&
        !streamDone &&
        fillersPlayed < maxFillers
      ) {
        const text =
          fillersPlayed === 0
            ? fillerText
            : pickContinuationFiller(fillerReason, usedFillers, recentSet);
        if (fillersPlayed > 0) this.trackRecentFiller(text);
        // Natural "breath" pause before the next filler. Scales with
        // position (later fillers → longer pause) so the pacing feels
        // like someone genuinely hesitating rather than reading a list.
        const trailingSilenceMs = 300 + fillersPlayed * 250;
        await this.streamTts(turnId, text, signal, {
          filler: true,
          speed: fillerSpeed,
          trailingSilenceMs,
        });
        fillersPlayed++;
      }

      // Drain sentences as they arrive. Each synth starts right after
      // the previous one finishes synth, so the client's scheduler
      // plays them with no gap (as long as synth is faster than
      // playback, which Kokoro typically is for short sentences).
      while (!signal.aborted) {
        if (sentenceQueue.length > 0) {
          const next = sentenceQueue.shift()!;
          agentText = agentText ? agentText + ' ' + next : next;
          await this.streamTts(turnId, next, signal);
        } else if (streamDone) {
          break;
        } else {
          await sleep(20);
        }
      }

      await tokensPromise;

      if (signal.aborted) {
        interrupted = true;
        this.metrics?.inc('interruptions_total');
      } else {
        await this.bus.emit({ type: 'tts.done', turnId, atMs: Date.now() });
      }
      this.metrics?.observe('ttfa_ms', Date.now() - startedAtMs, { tier: 'escalated' });
      this.metrics?.inc('turns_total', { tier: 'escalated' });
    } catch (err) {
      if (signal.aborted) {
        interrupted = true;
        this.metrics?.inc('interruptions_total');
      } else {
        this.logger?.error('escalation failed', { error: String(err) });
        this.metrics?.inc('escalation_errors_total');
        // Graceful fallback spoken to the user
        const apology = "Sorry, I can't reach that right now.";
        await this.streamTts(turnId, apology, signal).catch(() => undefined);
        agentText = apology;
      }
    } finally {
      this.arbiter.endTurn(turnId);
    }

    return {
      id: turnId,
      startedAtMs,
      endedAtMs: Date.now(),
      userText,
      intent: output.intent as Intent,
      agentText: agentText.trim(),
      tier: 'escalated',
      interrupted,
    };
  }

  private async playText(
    turnId: string,
    text: string,
  ): Promise<{ spoken: string; interrupted: boolean }> {
    if (text.length === 0) return { spoken: '', interrupted: false };
    const signal = this.arbiter.beginTurn(turnId, () => {});
    try {
      await this.bus.emit({ type: 'tts.start', turnId, atMs: Date.now() });
      await this.maybeApologize(turnId, signal);
      await this.streamTts(turnId, text, signal);
      await this.bus.emit({ type: 'tts.done', turnId, atMs: Date.now() });
      return { spoken: text, interrupted: signal.aborted };
    } finally {
      this.arbiter.endTurn(turnId);
    }
  }

  /**
   * Emit a quick apology if the previous turn was barge-in'd mid-reply.
   * "Sorry, please go ahead." style — acknowledges we cut the user off.
   */
  private async maybeApologize(turnId: string, signal: AbortSignal): Promise<void> {
    if (!this.pendingApology || signal.aborted) return;
    this.pendingApology = false;
    const recent = new Set(this.recentApologies);
    const apology = pickApology(recent);
    this.recentApologies.push(apology);
    while (this.recentApologies.length > 4) this.recentApologies.shift();
    await this.streamTts(turnId, apology, signal, {
      filler: true,
      speed: 0.95,
      trailingSilenceMs: 250,
    });
  }

  private async streamTts(
    turnId: string,
    text: string,
    signal: AbortSignal,
    opts: { filler?: boolean; speed?: number; trailingSilenceMs?: number } = {},
  ): Promise<string> {
    if (text.trim().length === 0) return '';
    const synthOpts: { signal: AbortSignal; speed?: number } = { signal };
    if (opts.speed !== undefined) synthOpts.speed = opts.speed;
    for await (const chunk of this.tts.synthesize(text, synthOpts)) {
      if (signal.aborted) break;
      // If the caller wants a gap after this chunk and we have real
      // PCM, append silence samples so the client's Web Audio
      // scheduler leaves a natural pause before the next chunk.
      const pcm =
        chunk.final && chunk.pcm && opts.trailingSilenceMs
          ? appendSilence(chunk.pcm, chunk.sampleRate, opts.trailingSilenceMs)
          : chunk.pcm;
      await this.bus.emit({
        type: 'tts.chunk',
        turnId,
        text: chunk.text,
        ...(pcm ? { pcm } : {}),
        sampleRate: chunk.sampleRate,
        atMs: Date.now(),
        final: chunk.final,
        ...(opts.filler ? { filler: true } : {}),
      });
    }
    return text;
  }

  /**
   * Forecast next-turn wait from the TTFT EMA and return how
   * aggressively we should pace and stack fillers. Note: the full wait
   * until we can start synthesizing the reply is TTFT + time to
   * complete the first sentence — typically 1-3x TTFT — so we cap
   * generously here.
   */
  private fillerStrategy(): { fillerSpeed: number; maxFillers: number } {
    const predicted = this.ttftEmaMs;
    // A TTFT in the 500-1000ms range still means 2-4s before we have
    // a full sentence + its audio synthesized. Bias `maxFillers` high
    // — the while loop exits early anyway once a sentence is ready.
    if (predicted < 1000) return { fillerSpeed: 0.95, maxFillers: 3 };
    if (predicted < 2500) return { fillerSpeed: 0.88, maxFillers: 4 };
    if (predicted < 5000) return { fillerSpeed: 0.80, maxFillers: 5 };
    return { fillerSpeed: 0.74, maxFillers: 6 };
  }

  private recordTtft(ms: number): void {
    this.ttftEmaMs = this.ttftEmaMs === 0 ? ms : this.ttftEmaMs * 0.7 + ms * 0.3;
  }

  private trackRecentFiller(text: string): void {
    if (!text) return;
    // Each recorded filler may be a multi-phrase chain — split and
    // track each individual phrase so we don't repeat the same lines
    // next turn, even if they appeared as part of a larger utterance.
    const parts = text.split(/(?<=[.!?])\s+/).filter((p) => p.trim().length > 0);
    for (const p of parts) {
      this.recentFillers.push(p);
      while (this.recentFillers.length > this.recentFillerCap) {
        this.recentFillers.shift();
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function appendSilence(pcm: Int16Array, sampleRate: number, ms: number): Int16Array {
  const silenceSamples = Math.max(0, Math.floor((sampleRate * ms) / 1000));
  if (silenceSamples === 0) return pcm;
  const out = new Int16Array(pcm.length + silenceSamples);
  out.set(pcm, 0);
  // trailing samples default to 0 = silence
  return out;
}
