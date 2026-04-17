import { reflexClassify } from '@oasis-echo/reflex';
import {
  DialogueStateStore,
  Guardrail,
  HeuristicRouter,
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
import { pickFiller } from './filler.js';

export type PipelineOpts = {
  sessionId: string;
  router?: Router;
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
  private fillerCounter = 0;
  private turnCounter = 0;

  constructor(opts: PipelineOpts) {
    this.bus = opts.bus ?? new EventBus();
    this.state = new DialogueStateStore({ sessionId: opts.sessionId });
    this.arbiter = new BargeInArbiter(this.bus, {
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.metrics ? { metrics: opts.metrics } : {}),
    });
    this.router = opts.router ?? new HeuristicRouter();
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
   * record once TTS has finished (or was interrupted).
   */
  async handleTurn(userText: string): Promise<Turn> {
    this.turnCounter++;
    const turnId = `t${this.turnCounter}-${Date.now().toString(36)}`;
    const startedAtMs = Date.now();
    const turnSpan = this.tracer?.start('turn', undefined, { turnId });

    // Reflex short-circuit
    const reflex = reflexClassify(userText);
    if (reflex) {
      const turn = await this.speakLocal(turnId, userText, reflex, 'reflex', startedAtMs);
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

    const fillerText =
      output.decision.filler ?? pickFiller(output.decision.reason, this.fillerCounter++);

    // Begin turn with arbiter; signal propagates to TTS and LLM
    const signal = this.arbiter.beginTurn(turnId, () => {});

    let agentText = '';
    let interrupted = false;

    try {
      await this.bus.emit({ type: 'tts.start', turnId, atMs: Date.now() });

      // (a) Filler audio starts immediately
      const fillerPromise = this.streamTts(turnId, fillerText, signal);

      // (b) Cloud reasoning begins in parallel
      const tokensPromise = this.streamCloud(turnId, userText, signal);

      const [fillerSpoken, cloudTokens] = await Promise.all([fillerPromise, tokensPromise]);

      agentText = fillerSpoken + ' ' + cloudTokens.text;

      if (!signal.aborted) {
        // Stream cloud tokens through sentence chunker → TTS
        const chunker = new SentenceChunker();
        const queue: string[] = [];
        for (const sentence of chunker.feed(cloudTokens.text)) queue.push(sentence);
        const flushed = chunker.flush();
        if (flushed) queue.push(flushed);
        for (const s of queue) {
          if (signal.aborted) break;
          await this.streamTts(turnId, s, signal);
        }
      }

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
      await this.streamTts(turnId, text, signal);
      await this.bus.emit({ type: 'tts.done', turnId, atMs: Date.now() });
      return { spoken: text, interrupted: signal.aborted };
    } finally {
      this.arbiter.endTurn(turnId);
    }
  }

  private async streamTts(turnId: string, text: string, signal: AbortSignal): Promise<string> {
    if (text.trim().length === 0) return '';
    for await (const chunk of this.tts.synthesize(text, { signal })) {
      if (signal.aborted) break;
      await this.bus.emit({
        type: 'tts.chunk',
        turnId,
        pcm: chunk.pcm,
        sampleRate: chunk.sampleRate,
        atMs: Date.now(),
        final: chunk.final,
      });
    }
    return text;
  }

  private async streamCloud(
    turnId: string,
    userText: string,
    signal: AbortSignal,
  ): Promise<{ text: string }> {
    let text = '';
    try {
      for await (const ev of this.reasoner.stream({ userText, state: this.state.snapshot(), signal })) {
        if (signal.aborted) break;
        if (ev.type === 'token') {
          text += ev.text;
          await this.bus.emit({ type: 'llm.token', turnId, token: ev.text, atMs: Date.now() });
        } else if (ev.type === 'done') {
          await this.bus.emit({ type: 'llm.done', turnId, atMs: Date.now() });
          this.metrics?.inc('llm_tokens_out_total', {}, ev.outputTokens);
          this.metrics?.inc('llm_tokens_in_total', {}, ev.inputTokens);
        }
      }
    } catch (err) {
      if (signal.aborted) return { text };
      throw err;
    }
    return { text };
  }
}
