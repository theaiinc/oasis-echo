import { reflexClassify } from '@oasis-echo/reflex';
import {
  DialogueStateStore,
  Guardrail,
  LastTurnsSummarizer,
  SentenceChunker,
  type Router,
  type SpeculationHit,
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

  /**
   * Fast path for committed speculations. Skips the router (already
   * decided) and filler logic (we already have sentences ready to
   * speak). Drains the pre-computed sentence stream through TTS and
   * emits the same turn.complete as a normal escalate / local.
   */
  async handleCommittedSpeculation(
    hit: SpeculationHit,
    userText: string,
    opts: { turnId?: string } = {},
  ): Promise<Turn> {
    this.turnCounter++;
    const turnId = opts.turnId ?? `t${this.turnCounter}-${Date.now().toString(36)}`;
    const startedAtMs = Date.now();
    const turnSpan = this.tracer?.start('turn', undefined, { turnId, speculated: 'hit' });

    await this.bus.emit({
      type: 'route.decision',
      turnId,
      decision: hit.routerOutput.decision,
      atMs: Date.now(),
    });

    const signal = this.arbiter.beginTurn(turnId, () => {});
    let agentText = '';
    let interrupted = false;

    try {
      await this.bus.emit({ type: 'tts.start', turnId, atMs: Date.now() });
      await this.maybeApologize(turnId, signal);

      // Drain sentences from the speculation buffer into a local queue
      // so the filler pre-roll below can race against "first sentence
      // is ready" without consuming it from the iterator.
      const sentenceQueue: string[] = [];
      let drainDone = false;
      const drainerPromise = (async () => {
        try {
          for await (const s of hit.sentences) {
            if (signal.aborted) break;
            sentenceQueue.push(s);
          }
        } catch {
          /* ignore — may be aborted */
        }
        drainDone = true;
      })();

      // Previously we skipped fillers here unconditionally, but that
      // left the user in dead silence when the speculation buffer was
      // empty at commit time — typically when the reasoner was
      // mid-tool-call and hadn't produced round-2 tokens yet. Race
      // first-sentence vs a short threshold; if the queue is still
      // empty, play short chained fillers until a sentence lands.
      const FILLER_THRESHOLD_MS = 500;
      await Promise.race([
        (async () => {
          while (sentenceQueue.length === 0 && !signal.aborted && !drainDone) {
            await sleep(20);
          }
        })(),
        sleep(FILLER_THRESHOLD_MS),
      ]);

      if (sentenceQueue.length === 0 && !drainDone && !signal.aborted) {
        const recentSet = new Set(this.recentFillers);
        const { fillerSpeed } = this.fillerStrategy();
        const usedFillers = new Set<string>();
        let fillersPlayed = 0;
        while (
          sentenceQueue.length === 0 &&
          !drainDone &&
          !signal.aborted
        ) {
          const filler = fillersPlayed === 0
            ? pickFirstFiller(recentSet)
            : pickContinuationFiller('thinking', usedFillers, recentSet);
          usedFillers.add(filler);
          this.trackRecentFiller(filler);
          const trailingSilenceMs = 300 + fillersPlayed * 250;
          await this.streamTts(turnId, filler, signal, {
            filler: true,
            speed: fillerSpeed,
            trailingSilenceMs,
          });
          fillersPlayed++;
        }
      }

      // Drain the queue; play each sentence as soon as it's available.
      while (!signal.aborted) {
        if (sentenceQueue.length > 0) {
          const next = sentenceQueue.shift()!;
          agentText = agentText ? agentText + ' ' + next : next;
          await this.streamTts(turnId, next, signal);
        } else if (drainDone) {
          break;
        } else {
          await sleep(20);
        }
      }
      await drainerPromise;
      await hit.done.catch(() => undefined);

      if (signal.aborted) {
        interrupted = true;
        this.metrics?.inc('interruptions_total');
      } else {
        await this.bus.emit({ type: 'tts.done', turnId, atMs: Date.now() });
      }
      this.metrics?.observe('ttfa_ms', Date.now() - startedAtMs, { tier: 'speculated' });
      this.metrics?.inc('turns_total', { tier: 'speculated' });
    } catch (err) {
      if (signal.aborted) {
        interrupted = true;
        this.metrics?.inc('interruptions_total');
      } else {
        this.logger?.error('speculation playback failed', { error: String(err) });
        const apology = "Sorry, I can't reach that right now.";
        await this.streamTts(turnId, apology, signal).catch(() => undefined);
        agentText = apology;
      }
    } finally {
      this.arbiter.endTurn(turnId);
    }

    const tier: 'local' | 'escalated' =
      hit.routerOutput.decision.kind === 'local' ? 'local' : 'escalated';
    const turn: Turn = {
      id: turnId,
      startedAtMs,
      endedAtMs: Date.now(),
      userText,
      intent: hit.routerOutput.intent as Intent,
      agentText: agentText.trim(),
      tier,
      interrupted,
    };

    this.pendingApology = turn.interrupted && turn.tier !== 'reflex';
    this.state.applyIntent(turn.intent ?? 'unknown');
    this.state.recordTurn(turn);

    if (this.turnCounter % this.summarizeEveryNTurns === 0) {
      try {
        const snapshot = this.state.snapshot();
        const summary = await this.summarizer.summarize(snapshot.turns, snapshot.summary);
        this.state.setSummary(summary);
      } catch (err) {
        this.logger?.warn('summarizer failed', { error: String(err) });
      }
    }

    if (turnSpan) this.tracer?.end(turnSpan, { tier, intent: turn.intent });
    await this.bus.emit({ type: 'turn.complete', turn });
    return turn;
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
      let streamError: unknown;
      let fullText = '';
      // Stateful filter that captures <think>...</think> blocks and
      // routes them via bus.emit('think.token') for the UI, while
      // stripping them from the TTS sentence stream.
      const thinkFilter = new ThinkingFilter(
        (token) => { void this.bus.emit({ type: 'think.token' as const, turnId, token, atMs: Date.now() }); },
      );

      // Track outstanding tool calls so the result event can report
      // accurate latency and name even when the reasoner multiplexes
      // several calls inside a single turn.
      const toolInflight = new Map<string, { name: string; startedAtMs: number }>();

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
              // Strip <think>...</think> blocks so reasoning tokens are
              // never synthesized into speech.
              const speakable = chunker.feed(thinkFilter.filter(ev.text));
              for (const sentence of speakable) sentenceQueue.push(sentence);
              if (speakable.length === 0) {
                const phrase = chunker.flushPhraseIfReady();
                if (phrase) sentenceQueue.push(phrase);
              }
            } else if (ev.type === 'tool_use') {
              toolInflight.set(ev.id, { name: ev.name, startedAtMs: Date.now() });
              await this.bus.emit({
                type: 'tool.use',
                turnId,
                toolCallId: ev.id,
                name: ev.name,
                input: ev.input,
                atMs: Date.now(),
              });
              this.metrics?.inc('tool_calls_total', { name: ev.name });
            } else if (ev.type === 'tool_result') {
              const entry = toolInflight.get(ev.id);
              toolInflight.delete(ev.id);
              const isErr = !!(ev.output && typeof ev.output === 'object'
                && 'error' in (ev.output as Record<string, unknown>));
              await this.bus.emit({
                type: 'tool.result',
                turnId,
                toolCallId: ev.id,
                name: entry?.name ?? 'tool',
                ok: !isErr,
                preview: previewOutput(ev.output),
                latencyMs: Date.now() - (entry?.startedAtMs ?? Date.now()),
                atMs: Date.now(),
              });
            } else if (ev.type === 'done') {
              const rest = chunker.flush();
              if (rest && rest.trim().length > 0) sentenceQueue.push(rest);
              await this.bus.emit({ type: 'llm.done', turnId, atMs: Date.now() });
              this.metrics?.inc('llm_tokens_out_total', {}, ev.outputTokens);
              this.metrics?.inc('llm_tokens_in_total', {}, ev.inputTokens);
            }
          }
        } catch (err) {
          if (!signal.aborted) streamError = err;
        }
        streamDone = true;
      })();


      // Race first-SENTENCE vs the filler threshold. We need a full
      // sentence to start synthesizing the reply, not just the first
      // token, so wait for sentenceQueue to actually have something.
      // If the model is fast enough that a sentence lands before the
      // threshold, we skip the filler entirely.
      const FILLER_THRESHOLD_MS = 600;
      const { fillerSpeed } = this.fillerStrategy();
      await Promise.race([
        (async () => {
          while (sentenceQueue.length === 0 && !signal.aborted && !streamDone) {
            await sleep(20);
          }
        })(),
        sleep(FILLER_THRESHOLD_MS),
      ]);

      // Play fillers while no speakable answer chunk has arrived.
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
      // Keep filling while we don't yet have a speakable answer chunk.
      // First-token alone isn't enough — local models can emit a token at
      // 700ms but take another few seconds to reach a sentence/clause break.
      // The loop exits immediately once SentenceChunker queues a safe chunk.
      while (
        sentenceQueue.length === 0 &&
        !signal.aborted &&
        !streamDone
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
      if (streamError) throw streamError;

      if (signal.aborted) {
        interrupted = true;
        this.metrics?.inc('interruptions_total');
      } else {
        if (agentText.trim().length === 0) {
          this.logger?.warn('empty escalated answer after reasoner stream', {
            turnId,
            userText: userText.slice(0, 120),
          });
          const fallback = "Sorry, I got stuck thinking. Please try again.";
          await this.streamTts(turnId, fallback, signal).catch(() => undefined);
          agentText = fallback;
        }
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
   * aggressively we should pace fillers. Note: the full wait
   * until we can start synthesizing the reply is TTFT + time to
   * reach the first sentence/clause boundary — typically 1-3x TTFT.
   */
  private fillerStrategy(): { fillerSpeed: number } {
    const predicted = this.ttftEmaMs;
    if (predicted < 1000) return { fillerSpeed: 0.95 };
    if (predicted < 2500) return { fillerSpeed: 0.88 };
    if (predicted < 5000) return { fillerSpeed: 0.80 };
    return { fillerSpeed: 0.74 };
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

/**
 * Collapse a tool result to a short human-readable preview. The UI
 * surfaces this in the event stream; pipeline logs pick it up too.
 * Never exceeds 180 chars so noisy HTML-scraped bodies don't blow out
 * log lines.
 */
function previewOutput(out: unknown): string {
  if (out == null) return '';
  if (typeof out === 'string') return out.replace(/\s+/g, ' ').slice(0, 180);
  try {
    const s = JSON.stringify(out);
    return s.replace(/\s+/g, ' ').slice(0, 180);
  } catch {
    return String(out).slice(0, 180);
  }
}

/**
 * Stateful filter that captures <think>...</think> blocks from a token
 * stream and routes them to a callback (for UI display) while stripping
 * them from the text returned to TTS.
 *
 * Tags and their content can span arbitrary token boundaries; the filter
 * tracks open/close state and accumulated partial matches.
 */
class ThinkingFilter {
  private readonly openTag = '<think>';
  private readonly closeTag = '</think>';
  private inside = false;
  private rawThoughtMode = false;
  private rawThoughtPrefixChecked = false;
  private rawThoughtProbe = '';
  private rawThoughtBuffer = '';
  /** Buffer for partial tag matching across token boundaries. */
  private partial = '';
  private readonly onThinkToken: (token: string) => void;

  constructor(onThinkToken: (token: string) => void) {
    this.onThinkToken = onThinkToken;
  }

  filter(token: string): string {
    if (this.rawThoughtMode) {
      return this.filterRawThought(token);
    }

    if (!this.rawThoughtPrefixChecked) {
      this.rawThoughtProbe += token;
      const rawThoughtStart = this.rawThoughtProbe.match(/^\s*thought\s*(?::|\r?\n)/i);
      if (rawThoughtStart) {
        this.rawThoughtPrefixChecked = true;
        this.rawThoughtMode = true;
        const rest = this.rawThoughtProbe.slice(rawThoughtStart[0].length);
        this.rawThoughtProbe = '';
        return this.filterRawThought(rest);
      }
      if (/^\s*(?:t|th|tho|thou|thoug|though|thought|thought\s*:?)$/i.test(this.rawThoughtProbe)) {
        return '';
      }
      this.rawThoughtPrefixChecked = true;
      token = this.rawThoughtProbe;
      this.rawThoughtProbe = '';
    }

    // Fully inside a think block — capture and drop everything.
    if (this.inside) {
      const ci = token.indexOf(this.closeTag);
      if (ci === -1) {
        this.onThinkToken(token);
        return '';
      }
      const beforeClose = token.slice(0, ci);
      if (beforeClose.length > 0) this.onThinkToken(beforeClose);
      this.inside = false;
      return this.filter(token.slice(ci + this.closeTag.length));
    }

    // Outside — check for an opening tag.
    const oi = token.indexOf(this.openTag);
    if (oi !== -1) {
      // Text before the open tag is regular reply
      const prefix = token.slice(0, oi);
      this.inside = true;
      const rest = this.filter(token.slice(oi + this.openTag.length));
      return prefix + (this.inside ? '' : rest);
    }

    // Handle partial tag splits across tokens.
    // Accumulate partial until we have enough to match.
    this.partial += token;
    let result = '';

    while (this.partial.length > 0) {
      const oi2 = this.partial.indexOf(this.openTag);
      if (oi2 !== -1) {
        result += this.partial.slice(0, oi2);
        this.partial = this.partial.slice(oi2 + this.openTag.length);
        this.inside = true;
        const ci2 = this.partial.indexOf(this.closeTag);
        if (ci2 !== -1) {
          // Capture content between open and close tag
          const thinkContent = this.partial.slice(0, ci2);
          if (thinkContent.length > 0) this.onThinkToken(thinkContent);
          this.inside = false;
          this.partial = this.partial.slice(ci2 + this.closeTag.length);
        } else {
          // Everything accumulated so far is content inside think
          if (this.partial.length > 0) {
            this.onThinkToken(this.partial);
          }
          this.partial = '';
        }
      } else if (this.partial.includes('<') && !this.partial.includes('>')) {
        // Token ends mid-tag — hold it for the next token.
        break;
      } else {
        result += this.partial;
        this.partial = '';
      }
    }

    return result;
  }

  /** Call when the stream ends to flush any held partial text. */
  flush(): string {
    if (!this.rawThoughtPrefixChecked && this.rawThoughtProbe.length > 0) {
      const out = this.rawThoughtProbe;
      this.rawThoughtProbe = '';
      this.rawThoughtPrefixChecked = true;
      return out;
    }
    if (this.rawThoughtMode) {
      if (this.rawThoughtBuffer.length > 0) {
        this.onThinkToken(this.rawThoughtBuffer);
      }
      this.rawThoughtBuffer = '';
      this.rawThoughtMode = false;
      return '';
    }
    // If we're inside a think block, remaining partial is thinking content
    if (this.inside && this.partial.length > 0) {
      this.onThinkToken(this.partial);
    }
    const out = this.partial;
    this.partial = '';
    return out;
  }

  private filterRawThought(token: string): string {
    this.rawThoughtBuffer += token;
    const marker = this.rawThoughtBuffer.match(/\b(?:response|answer|final)\s*:\s*/i);
    if (!marker || marker.index === undefined) {
      return '';
    }

    const thought = this.rawThoughtBuffer.slice(0, marker.index);
    if (thought.length > 0) this.onThinkToken(thought);
    this.rawThoughtMode = false;
    const reply = this.rawThoughtBuffer.slice(marker.index + marker[0].length);
    this.rawThoughtBuffer = '';
    return reply;
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
