import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadDotenv } from './env.js';
import {
  ContextBiasStage,
  CorrectionStore,
  EmotionAdaptiveTts,
  KokoroTts,
  OllamaRouter,
  PassthroughTts,
  PhraseMatcherStage,
  PostProcessPipeline,
  RuleStage,
  SemanticCorrectionStage,
  SpeculationManager,
  WhisperStreamingStt,
  alwaysEscalate,
  classifyQuestion,
  detectEmotionFromText,
  makeOllamaCorrector,
  normalizeSerLabel,
  type AdaptedReply,
  type AgentContext,
  type Emotion,
  type EmotionInput,
  type Router,
  type StreamingTts,
  type Strategy,
} from '@oasis-echo/coordinator';
import { Pipeline } from '@oasis-echo/orchestrator';
import {
  AnthropicReasoner,
  OllamaReasoner,
  OpenAIReasoner,
  ToolRegistry,
  echoTool,
  timeTool,
  type Reasoner,
} from '@oasis-echo/reasoning';
import { createLogger, Metrics, Tracer } from '@oasis-echo/telemetry';
import { loadConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Short "still listening" acknowledgements played while the user is
// mid-utterance. Pre-synthesized through Kokoro at startup so the
// client can trigger them instantly and play at Web-Audio volume.
//
// Avoid letter-only onomatopoeia like "mhm" or "Mm" — Kokoro's phonemizer
// reads those as letter names ("em-ech-em"). Stick to tokens with a vowel
// spelling the phonemizer can actually sound out.
const BACKCHANNEL_PHRASES = [
  'uh huh',
  'yeah',
  'right',
  'I see',
  'got it',
  'go on',
  'okay',
];

type BackchannelCacheEntry = { audio: string; sampleRate: number };
const backchannelCache = new Map<string, BackchannelCacheEntry>();

async function primeBackchannelCache(kokoro: KokoroTts): Promise<void> {
  for (const phrase of BACKCHANNEL_PHRASES) {
    for await (const chunk of kokoro.synthesize(phrase)) {
      if (!chunk.pcm) continue;
      const bytes = new Uint8Array(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength);
      backchannelCache.set(phrase, {
        audio: Buffer.from(bytes).toString('base64'),
        sampleRate: chunk.sampleRate,
      });
      break; // only one chunk per short phrase
    }
  }
}
// Load .env from the repo root so `ANTHROPIC_API_KEY=…` in that file
// switches the reasoner on without any export ceremony.
loadDotenv(join(__dirname, '..', '..', '..', '.env'));
loadDotenv(join(process.cwd(), '.env'));
const PORT = Number(process.env['PORT'] ?? 3000);
const HTML = readFileSync(join(__dirname, '..', 'src', 'index.html'), 'utf8');

type SseClient = {
  id: number;
  res: ServerResponse;
};

class Hub {
  private nextId = 1;
  private readonly clients = new Map<number, SseClient>();

  subscribe(req: IncomingMessage, res: ServerResponse): number {
    const id = this.nextId++;
    // Keep the socket open indefinitely; default Node timeouts will kill
    // idle SSE connections otherwise, which the browser reports as
    // "disconnected — reconnecting…".
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Initial comment flushes headers immediately; browser fires `open`.
    res.write(`: connected id=${id}\n\n`);
    const client = { id, res };
    this.clients.set(id, client);
    // Heartbeat every 15s keeps proxies and the browser happy.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        this.clients.delete(id);
      }
    }, 15_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(id);
    });
    return id;
  }

  broadcast(type: string, payload: unknown): void {
    let line: string;
    try {
      line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    } catch (err) {
      line = `event: error\ndata: ${JSON.stringify({ source: 'serialize', error: String(err), atMs: Date.now() })}\n\n`;
    }
    for (const c of this.clients.values()) {
      try {
        c.res.write(line);
      } catch {
        this.clients.delete(c.id);
      }
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel, bindings: { session: cfg.sessionId } });
  const metrics = new Metrics();
  const tools = new ToolRegistry();
  tools.register(timeTool());
  tools.register(echoTool());

  let reasoner: Reasoner;
  if (cfg.backend === 'anthropic') {
    reasoner = new AnthropicReasoner({ logger, tools, model: cfg.model });
    logger.info('reasoner', { backend: 'anthropic', model: cfg.model });
  } else if (cfg.backend === 'ollama') {
    reasoner = new OllamaReasoner({
      logger,
      model: cfg.model,
      baseUrl: cfg.ollamaBaseUrl,
    });
    logger.info('reasoner', { backend: 'ollama', model: cfg.model, baseUrl: cfg.ollamaBaseUrl });
  } else {
    reasoner = new OpenAIReasoner({
      logger,
      model: cfg.model,
      baseUrl: cfg.openaiBaseUrl,
    });
    logger.info('reasoner', { backend: 'openai', model: cfg.model, baseUrl: cfg.openaiBaseUrl });
  }

  // Tier-1 coordinator: SLM-backed routing via Ollama. Small JSON
  // output (intent + reply or escalation) informed by the router
  // prompt + few-shot examples. Falls through to `alwaysEscalate`
  // inline if the SLM call ever fails.
  const slm = new OllamaRouter({
    baseUrl: cfg.routerBaseUrl,
    model: cfg.routerModel,
    logger,
    fallback: alwaysEscalate,
  });
  const router: Router = slm;
  void slm.warm();
  logger.info('router', { backend: 'slm', model: cfg.routerModel, baseUrl: cfg.routerBaseUrl });

  let tts: StreamingTts;
  let kokoroInstance: KokoroTts | null = null;
  if (cfg.ttsBackend === 'kokoro') {
    kokoroInstance = new KokoroTts({
      logger,
      voice: cfg.kokoroVoice,
      dtype: cfg.kokoroDtype,
    });
    tts = kokoroInstance;
    // Warm the model in the background so the first turn isn't a
    // 10-second cold start. While loading, the passthrough path below
    // kicks in so the pipeline still functions.
    void kokoroInstance.warm().then(async () => {
      // After warm-up, synthesize each backchannel phrase once and
      // cache the PCM so the client can fetch them instantly at full
      // volume (speechSynthesis output is typically much quieter than
      // Web Audio, which was making the backchannel barely audible).
      await primeBackchannelCache(kokoroInstance!);
      logger.info('backchannel cache primed', { count: backchannelCache.size });
    }).catch((err) => {
      logger.error('kokoro warm failed', { error: String(err) });
    });
  } else {
    // Text-only passthrough — the browser client voices each chunk
    // via speechSynthesis on receipt.
    tts = new PassthroughTts();
  }

  const pipeline = new Pipeline({
    sessionId: cfg.sessionId,
    router,
    reasoner,
    tts,
    logger,
    metrics,
    tracer: new Tracer(),
  });

  // Speculative execution: run router + reasoner on stable partials
  // while the user is still speaking, so first TTS chunk can fire
  // within tens of milliseconds of the commit when the partial matches.
  const speculation = new SpeculationManager({
    router,
    reasoner,
    getState: () => pipeline.state.snapshot(),
    logger,
  });

  // STT post-processing pipeline: cleans the raw transcript before it
  // hits the dialogue pipeline. Three stages in order:
  //   1. rules   — strip fillers, collapse repeats, phonetic fixes
  //   2. phrases — snap noisy text to known canonical phrases
  //   3. semantic — LLM-based correction, conditional on low confidence
  //                 or ambiguity markers
  //
  // The pipeline is REBUILT on every user correction: when POST
  // /correction arrives, the CorrectionStore updates its word-rule
  // and phrase buckets, and we swap in a fresh pipeline so future
  // turns pick up the new data without restarting the server.
  const correctionsPath =
    process.env['OASIS_CORRECTIONS_FILE'] ??
    join(process.cwd(), '.oasis-corrections.json');
  const correctionStore = new CorrectionStore(correctionsPath, () => {
    postprocess = buildPostProcess();
    logger.info('postprocess rebuilt', {
      wordRules: Object.keys(correctionStore.wordRules()).length,
      phrases: correctionStore.phrases().length,
    });
  });

  function buildPostProcess(): PostProcessPipeline {
    return new PostProcessPipeline([
      new RuleStage({
        phoneticFixes: {
          // Baseline common-speech normalizations.
          gonna: 'going to',
          wanna: 'want to',
          gotta: 'got to',
          cuz: 'because',
          lemme: 'let me',
          gimme: 'give me',
          // User-learned rules from past /correction calls.
          ...correctionStore.wordRules(),
        },
      }),
      // Context-bias runs AFTER rules (so it sees cleaned text) but
      // BEFORE phrase matching (a successful context snap can feed a
      // cleaner phrase match). Skipped automatically when no agent
      // context exists or the topic-change gate fires.
      new ContextBiasStage({}),
      new PhraseMatcherStage({
        // Seed list + anything the user has taught us.
        phrases: [...loadPhraseList(), ...correctionStore.phrases()],
        similarityThreshold: 0.78,
      }),
      ...(cfg.backend === 'ollama'
        ? [
            new SemanticCorrectionStage({
              correct: makeOllamaCorrector({
                baseUrl: cfg.ollamaBaseUrl,
                model: cfg.routerModel,
                logger,
              }),
              minConfidenceToRun: 0.6,
              timeoutMs: 2500,
            }),
          ]
        : []),
    ]);
  }

  await correctionStore.load();
  let postprocess = buildPostProcess();
  logger.info('corrections loaded', {
    path: correctionsPath,
    wordRules: Object.keys(correctionStore.wordRules()).length,
    phrases: correctionStore.phrases().length,
  });

  const hub = new Hub();

  // Rolling agent context, fed into the STT post-processor on every
  // subsequent user turn. Updated on turn.complete so the NEXT user
  // utterance sees the assistant's latest reply.
  let agentContext: AgentContext = {};

  // Emotion-Adaptive TTS. Client-side SER classifier attaches
  // `{ emotion, confidence }` to POST /turn; we resolve a strategy,
  // compute TTS directives, broadcast them on an `emotion.directives`
  // event, and the client applies them to incoming tts.chunk events.
  const emotionAdapter = new EmotionAdaptiveTts();
  const emotionHistory: Emotion[] = [];
  const EMOTION_HISTORY_MAX = 6;
  // Active directives per in-flight turn, so chunked tts.chunk events
  // can be decorated with the same emotion envelope for the whole turn.
  const activeDirectives = new Map<string, AdaptedReply>();

  // Log high-signal turn events to the server stdout so the live log
  // is actually useful (not just GET /state polling).
  pipeline.bus.on('route.decision', (e) => {
    logger.info('route', { turnId: e.turnId, kind: e.decision.kind, intent: e.decision.intent });
  });
  pipeline.bus.on('turn.complete', (e) => {
    const agentText = e.turn.agentText ?? '';
    if (agentText.trim()) {
      const pendingQuestion = classifyQuestion(agentText);
      agentContext = {
        lastUtterance: agentText,
        ...(pendingQuestion ? { pendingQuestion } : {}),
      };
    }
    logger.info('turn', {
      id: e.turn.id,
      tier: e.turn.tier,
      intent: e.turn.intent,
      interrupted: e.turn.interrupted,
      userText: e.turn.userText.slice(0, 120),
      agentText: agentText.slice(0, 300),
      pendingQ: agentContext.pendingQuestion?.kind ?? 'none',
      latencyMs: (e.turn.endedAtMs ?? 0) - e.turn.startedAtMs,
    });
  });

  // Relay every pipeline event to connected SSE clients.
  pipeline.bus.onAny((event) => {
    if (event.type === 'tts.chunk') {
      const payload: Record<string, unknown> = {
        turnId: event.turnId,
        text: event.text,
        sampleRate: event.sampleRate,
        final: event.final,
        filler: event.filler === true,
        atMs: event.atMs,
      };
      if (event.pcm && event.pcm.length > 0) {
        // Real PCM — base64-encode the bytes so it survives JSON.
        const bytes = new Uint8Array(event.pcm.buffer, event.pcm.byteOffset, event.pcm.byteLength);
        payload['audio'] = Buffer.from(bytes).toString('base64');
      }
      hub.broadcast('tts.chunk', payload);
    } else if (event.type === 'audio.frame') {
      // skip — very noisy, not useful in the UI
    } else {
      // All other events serialize cleanly
      hub.broadcast(event.type, event);
    }
  });

  /**
   * Emit a single `stt.final` for the UI. Previously this function
   * replayed the text word-by-word with a 40ms sleep per word for a
   * "typing" effect; that added up to ~1s of blocking delay on long
   * utterances BEFORE the reasoner's pre-buffered reply could flow
   * through TTS. With `sendPartial` streaming every browser interim
   * during the utterance, the UI already has live transcript — the
   * animation is redundant.
   */
  function emitFinalTranscript(text: string, turnId: string): void {
    hub.broadcast('stt.final', { turnId, text: text.trim(), atMs: Date.now() });
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const reqStart = Date.now();
    res.on('finish', () => {
      process.stdout.write(
        `  ${req.method ?? 'GET'} ${url.pathname} → ${res.statusCode} (${Date.now() - reqStart}ms)\n`,
      );
    });

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      hub.subscribe(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          backend: cfg.backend,
          model: cfg.model,
          ...(cfg.backend === 'ollama' ? { baseUrl: cfg.ollamaBaseUrl } : {}),
          ...(cfg.backend === 'openai' ? { baseUrl: cfg.openaiBaseUrl } : {}),
          tts: {
            backend: cfg.ttsBackend,
            ...(cfg.ttsBackend === 'kokoro'
              ? {
                  voice: cfg.kokoroVoice,
                  dtype: cfg.kokoroDtype,
                  ready: kokoroInstance?.isReady ?? false,
                }
              : {}),
          },
          session: cfg.sessionId,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      const s = pipeline.state.snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          phase: s.phase,
          allowedIntents: s.allowedIntents,
          slots: s.slots,
          turns: s.turns.length,
          summary: s.summary,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/backchannel') {
      // Hand out a random pre-synthesized Kokoro clip. Empty payload
      // if the cache hasn't primed yet — client falls back to
      // speechSynthesis in that case.
      const phrases = [...backchannelCache.keys()];
      if (phrases.length === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: false }));
        return;
      }
      const phrase = phrases[Math.floor(Math.random() * phrases.length)]!;
      const entry = backchannelCache.get(phrase)!;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: true, text: phrase, ...entry }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics.snapshot()));
      return;
    }

    // Serve the compiled SDK as static ESM for the browser. We keep
    // this simple — no mimetype table, just .js files resolving into
    // packages/sdk/dist/. index.html pulls it in via an importmap.
    if (req.method === 'GET' && url.pathname.startsWith('/sdk/')) {
      const rel = url.pathname.replace(/^\/sdk\//, '');
      if (rel.includes('..')) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const target = rel.endsWith('.js') ? rel : `${rel}/index.js`;
      const absolute = join(__dirname, '..', '..', 'sdk', 'dist', target);
      try {
        const content = readFileSync(absolute, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/turn') {
      const body = await readBody(req);
      const parsed = (() => {
        try {
          return JSON.parse(body) as {
            text?: unknown;
            emotion?: { label?: unknown; confidence?: unknown; strategy?: unknown };
            speculationId?: unknown;
            partial?: unknown;
          };
        } catch {
          return {};
        }
      })();
      const text = String(parsed.text ?? '');
      if (!text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing text' }));
        return;
      }
      const speculationId =
        typeof parsed.speculationId === 'string' && parsed.speculationId.trim().length > 0
          ? parsed.speculationId
          : null;
      // Partial-update branch: the user is still talking. Fire router
      // + reasoner speculatively, then return quickly. No SSE events
      // flow from this call until the matching commit arrives.
      if (parsed.partial === true && speculationId) {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, speculating: true }));
        try {
          speculation.update(speculationId, text);
        } catch (err) {
          logger.warn('speculation update threw', { error: String(err) });
        }
        return;
      }
      // Parse optional emotion payload from the client's SER classifier.
      let detectedEmotion: Emotion | null = null;
      let detectedConfidence = 0;
      let requestedStrategy: Strategy | undefined;
      if (parsed.emotion && typeof parsed.emotion === 'object') {
        const raw = parsed.emotion;
        if (typeof raw.label === 'string') {
          detectedEmotion = normalizeSerLabel(raw.label);
        }
        if (typeof raw.confidence === 'number') {
          detectedConfidence = Math.max(0, Math.min(1, raw.confidence));
        }
        if (raw.strategy === 'mirror' || raw.strategy === 'soften' || raw.strategy === 'counterbalance') {
          requestedStrategy = raw.strategy;
        }
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
      // Assign one turnId up front so transcription, routing, and TTS
      // events all share a stable key for the UI.
      const turnId = `t-${Date.now().toString(36)}`;
      hub.broadcast('user.input', {
        turnId,
        text,
        atMs: Date.now(),
        ...(detectedEmotion ? { emotion: { label: detectedEmotion, confidence: detectedConfidence } } : {}),
      });
      void (async () => {
        try {
          // ─── Speculation-first ordering ────────────────────────
          // Previously STT-postprocess (semantic LLM call, 1-2s) +
          // simulateTranscription (~1s) ran BEFORE speculation.commit
          // could promote the buffered reply. That silence is why
          // the first TTS chunk took 3-5s to arrive on hit turns.
          //
          // New ordering:
          //   1. Try speculation.commit with the RAW user text.
          //      (Speculation was seeded on raw text via sendPartial,
          //       so the similarity check lines up without postprocess
          //       touching anything.)
          //   2. On HIT — skip postprocess entirely. The buffered
          //      reply matches the user's actual words. Emit a single
          //      stt.final immediately for the UI. Jump to TTS.
          //   3. On MISS — fall back to postprocess + fresh pipeline
          //      as before. That path runs the reasoner from scratch
          //      anyway so an extra 1-2s of postprocess doesn't hurt
          //      (and `escalate`'s filler bridges the gap).
          let specResult: Awaited<ReturnType<typeof speculation.commit>> | null = null;
          if (speculationId) {
            specResult = await speculation.commit(speculationId, text);
          }

          let cleanText: string;
          if (specResult?.kind === 'hit') {
            cleanText = text;
            emitFinalTranscript(cleanText, turnId);
            logger.info('speculation.promoted', {
              turnId,
              decision: specResult.routerOutput.decision.kind,
              intent: specResult.routerOutput.intent,
            });
          } else {
            if (specResult) {
              logger.info('speculation.missed', {
                turnId,
                reason: specResult.reason,
              });
            }
            // STT post-processing (semantic LLM, rules, context-bias).
            // Only runs on miss so the hit path doesn't pay its cost.
            const pp = await postprocess.process({
              text,
              ...(agentContext.lastUtterance ? { agentContext } : {}),
            });
            if (pp.stagesApplied.length > 0) {
              logger.info('stt.postprocess', {
                turnId,
                original: pp.original,
                final: pp.text,
                stages: pp.stagesApplied,
                latencyMs: pp.latencyMs,
              });
              hub.broadcast('stt.postprocess', {
                turnId,
                original: pp.original,
                final: pp.text,
                stages: pp.stagesApplied,
                history: pp.history,
                latencyMs: pp.latencyMs,
                atMs: Date.now(),
              });
            }
            cleanText = pp.text;
            emitFinalTranscript(cleanText, turnId);
          }

          // Complementary emotion signals.
          //
          //   acoustic (from client SER): strong on arousal-driven
          //     emotions (happy / surprise / angry / fear) where
          //     energy + pitch signatures are clear.
          //   text (keyword/regex on the cleaned transcript): strong
          //     on meaning-driven emotions (sad / frustrated /
          //     confused / urgent) that are usually carried by the
          //     words themselves rather than tone.
          //
          // Fusion policy:
          //   - If acoustic forwarded a label, trust it (client
          //     already filtered the unreliable sad/neutral/calm).
          //   - Otherwise fall back to text if any rule matched.
          //   - If both fire, prefer acoustic unless text has
          //     materially higher confidence AND a meaning-driven
          //     label the acoustic classifier can't see well.
          const textSignal = detectEmotionFromText(cleanText);
          let emoSource: 'acoustic' | 'text' | 'none' = 'none';
          let fusedEmotion: Emotion | null = detectedEmotion;
          let fusedConfidence = detectedConfidence;
          if (detectedEmotion) {
            emoSource = 'acoustic';
            const meaningDriven =
              textSignal &&
              ['sad', 'frustrated', 'confused', 'urgent'].includes(textSignal.emotion);
            if (meaningDriven && textSignal.confidence > detectedConfidence + 0.1) {
              fusedEmotion = textSignal.emotion;
              fusedConfidence = textSignal.confidence;
              emoSource = 'text';
            }
          } else if (textSignal) {
            fusedEmotion = textSignal.emotion;
            fusedConfidence = textSignal.confidence;
            emoSource = 'text';
          }

          // Emotion adaptation: compute directives BEFORE the reasoner
          // runs so the first tts.chunk can already carry them. Params
          // depend on emotion + history, not on the agent text, so we
          // don't need to wait for the reasoner.
          if (fusedEmotion) {
            // Text signal is weaker than acoustic (we're inferring from
            // words, not tone), so default to `soften` when the emotion
            // came from text — pulls the parameters toward neutral so
            // the adaptation is felt as a gentle tint, not a whiplash.
            // A client-requested strategy always wins.
            const effectiveStrategy: Strategy | undefined =
              requestedStrategy ?? (emoSource === 'text' ? 'soften' : undefined);
            const input: EmotionInput = {
              text: cleanText,
              emotion: fusedEmotion,
              confidence: fusedConfidence,
              ...(effectiveStrategy ? { strategy: effectiveStrategy } : {}),
              context: {
                previousEmotions: emotionHistory.slice(),
                interactionState: 'ongoing',
              },
            };
            const adapted = emotionAdapter.adapt(input);
            activeDirectives.set(turnId, adapted);
            emotionHistory.push(fusedEmotion);
            if (emotionHistory.length > EMOTION_HISTORY_MAX) emotionHistory.shift();
            logger.info('emotion.adapted', {
              turnId,
              source: emoSource,
              detected: fusedEmotion,
              confidence: Number(fusedConfidence.toFixed(2)),
              ...(textSignal
                ? { textCue: { emotion: textSignal.emotion, matched: textSignal.matched } }
                : {}),
              effective: adapted.output.effectiveEmotion,
              strategy: adapted.output.strategyApplied,
              rationale: adapted.output.rationale,
              directives: {
                playbackRate: Number(adapted.directives.playbackRate.toFixed(2)),
                gain: Number(adapted.directives.gain.toFixed(2)),
                interChunkSilenceMs: adapted.directives.interChunkSilenceMs,
                pitchSemitones: adapted.directives.pitchSemitones,
              },
            });
            hub.broadcast('emotion.directives', {
              turnId,
              source: emoSource,
              detected: fusedEmotion,
              confidence: fusedConfidence,
              effective: adapted.output.effectiveEmotion,
              strategy: adapted.output.strategyApplied,
              styleTags: adapted.output.styleTags,
              rationale: adapted.output.rationale,
              directives: adapted.directives,
              atMs: Date.now(),
            });
          }

          // Speculation.commit already ran above (pre-postprocess) so
          // the hit/miss decision and the pipeline hand-off are split:
          //   HIT  → handleCommittedSpeculation with raw-but-committed
          //          text (postprocess was skipped)
          //   MISS → handleTurn with postprocessed text
          let turn;
          if (specResult?.kind === 'hit') {
            turn = await pipeline.handleCommittedSpeculation(specResult, cleanText, { turnId });
          } else {
            turn = await pipeline.handleTurn(cleanText, { turnId });
          }
          hub.broadcast('turn.summary', {
            turnId: turn.id,
            tier: turn.tier,
            intent: turn.intent,
            interrupted: turn.interrupted,
            latencyMs: (turn.endedAtMs ?? 0) - turn.startedAtMs,
          });
          // Turn finished — drop any held directives for this turnId so
          // the map doesn't grow unbounded.
          activeDirectives.delete(turnId);
        } catch (err) {
          hub.broadcast('error', { source: 'turn', error: String(err), atMs: Date.now() });
        }
      })();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/bargein') {
      // Accept an optional `speculationId` so the client can tear down
      // any in-flight pre-computation for the abandoned turn.
      let bargeSpeculationId: string | null = null;
      try {
        const b = await readBody(req);
        if (b) {
          const p = JSON.parse(b) as { speculationId?: unknown };
          if (typeof p.speculationId === 'string') bargeSpeculationId = p.speculationId;
        }
      } catch { /* tolerate empty/bad body */ }
      if (bargeSpeculationId) speculation.abort(bargeSpeculationId);
      const interrupted = await pipeline.bargeIn();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ interrupted }));
      return;
    }

    // Teach the STT pipeline a correction. Body: { original, corrected }.
    // Single-word diff → word rule (RuleStage.phoneticFixes).
    // Multi-word corrected → also indexed as a canonical phrase
    // (PhraseMatcherStage.phrases). The in-memory pipeline is rebuilt
    // via the onChange callback so subsequent turns pick it up.
    if (req.method === 'POST' && url.pathname === '/correction') {
      const body = await readBody(req);
      let original = '';
      let corrected = '';
      try {
        const parsed = JSON.parse(body) as { original?: unknown; corrected?: unknown };
        original = String(parsed.original ?? '').trim();
        corrected = String(parsed.corrected ?? '').trim();
      } catch {
        // fall through to validation below
      }
      if (!original || !corrected) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing original or corrected' }));
        return;
      }
      const analysis = await correctionStore.addCorrection(original, corrected);
      logger.info('correction', {
        original,
        corrected,
        wordPairs: analysis.wordPairs,
        addedAsPhrase: analysis.addAsPhrase,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          accepted: true,
          wordPairs: analysis.wordPairs,
          addedAsPhrase: analysis.addAsPhrase,
          wordRules: correctionStore.wordRules(),
          phrases: correctionStore.phrases(),
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/corrections') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          wordRules: correctionStore.wordRules(),
          phrases: correctionStore.phrases(),
          history: correctionStore.history(),
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  // Node 18+ defaults requestTimeout to 300s and headersTimeout to 60s,
  // and closes idle sockets. SSE is long-lived, so loosen these.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 120_000;
  server.timeout = 0;

  // ──────────────────────── WebSocket /audio ────────────────────────
  // Streaming upstream: client sends PCM16 16kHz mono binary frames;
  // server runs streaming Whisper and sends back stt.partial events in
  // real time. Control messages flow as JSON text frames in both
  // directions. Pre-existing HTTP flow (SSE events + POST /turn) stays
  // authoritative for turn commit + TTS chunks; this endpoint purely
  // replaces the browser's SpeechRecognition with server-side STT.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/audio') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    socket.destroy();
  });

  // NOTE: previously warmed the Whisper model at startup to spare the
  // first WebSocket client a cold load. That caused a SIGSEGV because
  // two ONNX Runtime sessions (Whisper + Kokoro) racing during startup
  // destabilize the native runtime. First connection now triggers the
  // load; transformers.js caches the weights so subsequent connections
  // are fast.

  wss.on('connection', (ws: WebSocket) => {
    const stt = new WhisperStreamingStt({ logger });
    // Fire-and-forget: download the model in the background so the
    // first partial doesn't pay the full cold-start cost.
    stt.preload().catch(() => {});
    let sessionSpeculationId: string | null = null;
    let partialLoopTimer: ReturnType<typeof setInterval> | null = null;
    let lastEmittedPartial = '';
    let closed = false;

    const emit = (payload: Record<string, unknown>): void => {
      if (closed || ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    };

    const startPartialLoop = (): void => {
      if (partialLoopTimer) return;
      partialLoopTimer = setInterval(() => {
        void (async () => {
          try {
            const p = await stt.partial();
            if (p !== null && p !== lastEmittedPartial) {
              lastEmittedPartial = p;
              emit({ type: 'stt.partial', text: p, atMs: Date.now() });
              // Fire speculation on the server's own partials as they
              // grow — bypasses the client debouncer entirely. Only
              // start speculating once we have ~3 words of text.
              if (sessionSpeculationId && p.trim().split(/\s+/).length >= 3) {
                try {
                  speculation.update(sessionSpeculationId, p);
                } catch (err) {
                  logger.warn('server-partial speculation failed', {
                    error: String(err),
                  });
                }
              }
            }
          } catch (err) {
            logger.warn('stt partial loop error', { error: String(err) });
          }
        })();
      }, 400);
    };

    const stopPartialLoop = (): void => {
      if (partialLoopTimer) {
        clearInterval(partialLoopTimer);
        partialLoopTimer = null;
      }
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Binary frame = Float32 PCM at 16kHz mono.
        //
        // Node's `Buffer` instances are views into a shared pool and
        // carry an arbitrary `byteOffset` which is NOT guaranteed to
        // be 4-byte aligned. Creating a Float32Array directly on such
        // a buffer throws `start offset of Float32Array should be a
        // multiple of 4` and takes down the whole process (libc++abi
        // mutex crash follows because ONNX Runtime is mid-inference).
        //
        // We copy into a fresh aligned ArrayBuffer. One memcpy; cost
        // is negligible for ~170-byte PCM blocks.
        const buf = data as Buffer;
        const aligned = new ArrayBuffer(buf.byteLength - (buf.byteLength % 4));
        new Uint8Array(aligned).set(buf.subarray(0, aligned.byteLength));
        const f32 = new Float32Array(aligned);
        stt.feed(f32);
        startPartialLoop();
        return;
      }
      // Text frame — JSON control message.
      let msg: { type?: string; speculationId?: string } = {};
      try {
        msg = JSON.parse(data.toString('utf8')) as {
          type?: string;
          speculationId?: string;
        };
      } catch {
        return;
      }
      if (msg.type === 'start') {
        sessionSpeculationId = msg.speculationId ?? null;
        stt.reset();
        lastEmittedPartial = '';
        emit({ type: 'ready', atMs: Date.now() });
      } else if (msg.type === 'end') {
        // User signaled end of utterance. Produce a final transcript
        // and hand back to the client; it will post /turn with that
        // text + the same speculationId to promote the buffer.
        void (async () => {
          stopPartialLoop();
          const finalText = await stt.transcribeAll();
          emit({
            type: 'stt.final',
            text: finalText,
            speculationId: sessionSpeculationId,
            atMs: Date.now(),
          });
          stt.reset();
          lastEmittedPartial = '';
          sessionSpeculationId = null;
        })();
      } else if (msg.type === 'abort') {
        stopPartialLoop();
        stt.reset();
        lastEmittedPartial = '';
        if (sessionSpeculationId) {
          speculation.abort(sessionSpeculationId);
          sessionSpeculationId = null;
        }
      }
    });

    ws.on('close', () => {
      closed = true;
      stopPartialLoop();
      if (sessionSpeculationId) speculation.abort(sessionSpeculationId);
    });
  });

  server.listen(PORT, () => {
    const reasonerLabel =
      cfg.backend === 'anthropic'
        ? `anthropic (${cfg.model})`
        : cfg.backend === 'ollama'
        ? `ollama (${cfg.model} @ ${cfg.ollamaBaseUrl})`
        : `openai (${cfg.model} @ ${cfg.openaiBaseUrl})`;
    const ttsLabel =
      cfg.ttsBackend === 'kokoro'
        ? `kokoro (${cfg.kokoroVoice}, ${cfg.kokoroDtype})`
        : 'web-speech (browser)';
    const routerLabel = `slm (${cfg.routerModel})`;
    process.stdout.write(
      `\n  oasis-echo web is live at http://localhost:${PORT}\n` +
        `  router:   ${routerLabel}\n` +
        `  reasoner: ${reasonerLabel}\n` +
        `  tts:      ${ttsLabel}\n` +
        `  session:  ${cfg.sessionId}\n\n`,
    );
  });
}

/**
 * Load the canonical-phrase list for the PhraseMatcherStage.
 * Reads `OASIS_STT_PHRASES_FILE` if set (one phrase per line, `#`
 * comments allowed); otherwise returns a small illustrative seed list.
 */
function loadPhraseList(): string[] {
  const path = process.env['OASIS_STT_PHRASES_FILE'];
  if (path) {
    try {
      const content = readFileSync(path, 'utf8');
      return content
        .split('\n')
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter((l) => l.length > 0);
    } catch {
      // fall through to defaults
    }
  }
  return [
    'send an email',
    'schedule a meeting',
    'set a timer',
    'set an alarm',
    'turn on the lights',
    'turn off the lights',
    'play some music',
    'pause the music',
    'what time is it',
    'what is the weather',
  ];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
