import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from './env.js';
import {
  ContextBiasStage,
  CorrectionStore,
  KokoroTts,
  OllamaRouter,
  PassthroughTts,
  PhraseMatcherStage,
  PostProcessPipeline,
  RuleStage,
  SemanticCorrectionStage,
  alwaysEscalate,
  classifyQuestion,
  makeOllamaCorrector,
  type AgentContext,
  type Router,
  type StreamingTts,
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

  async function simulateTranscription(text: string, turnId: string): Promise<void> {
    const words = text.split(/(\s+)/).filter((w) => w.length > 0);
    let partial = '';
    for (let i = 0; i < words.length; i++) {
      if (i > 0) await sleep(40);
      partial += words[i];
      hub.broadcast('stt.partial', {
        turnId,
        text: partial,
        atMs: Date.now(),
      });
    }
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

    if (req.method === 'POST' && url.pathname === '/turn') {
      const body = await readBody(req);
      const text = (() => {
        try {
          return String((JSON.parse(body) as { text?: unknown }).text ?? '');
        } catch {
          return '';
        }
      })();
      if (!text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing text' }));
        return;
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
      // Assign one turnId up front so transcription, routing, and TTS
      // events all share a stable key for the UI.
      const turnId = `t-${Date.now().toString(36)}`;
      hub.broadcast('user.input', { turnId, text, atMs: Date.now() });
      void (async () => {
        try {
          // STT post-processing first. If a stage mutates the text,
          // log the diff and broadcast a trace event so the UI can
          // show "cleaned from X to Y" for debugging. Agent context
          // from the previous turn feeds context-bias + semantic.
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
          const cleanText = pp.text;
          await simulateTranscription(cleanText, turnId);
          const turn = await pipeline.handleTurn(cleanText, { turnId });
          hub.broadcast('turn.summary', {
            turnId: turn.id,
            tier: turn.tier,
            intent: turn.intent,
            interrupted: turn.interrupted,
            latencyMs: (turn.endedAtMs ?? 0) - turn.startedAtMs,
          });
        } catch (err) {
          hub.broadcast('error', { source: 'turn', error: String(err), atMs: Date.now() });
        }
      })();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/bargein') {
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
