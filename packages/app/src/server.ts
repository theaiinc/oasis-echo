import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from './env.js';
import {
  HeuristicRouter,
  KokoroTts,
  MockTts,
  OllamaRouter,
  PassthroughRouter,
  type Router,
  type StreamingTts,
} from '@oasis-echo/coordinator';
import { Pipeline } from '@oasis-echo/orchestrator';
import {
  AnthropicReasoner,
  MockReasoner,
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
const BACKCHANNEL_PHRASES = [
  'uh huh',
  'yeah',
  'mhm',
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
  } else if (cfg.backend === 'openai') {
    reasoner = new OpenAIReasoner({
      logger,
      model: cfg.model,
      baseUrl: cfg.openaiBaseUrl,
    });
    logger.info('reasoner', { backend: 'openai', model: cfg.model, baseUrl: cfg.openaiBaseUrl });
  } else {
    reasoner = new MockReasoner();
    logger.info('reasoner', { backend: 'mock' });
  }

  // Router selection:
  //   slm         → SLM-backed (Tier-1 coordinator) using Ollama
  //                 for intent + reply decisions. Falls back to
  //                 passthrough if the SLM call fails.
  //   passthrough → always escalate past the reflex tier (useful for
  //                 pure cloud setups where every turn goes to Claude).
  //   heuristic   → regex rules, no model call. Fast but dumb.
  let router: Router;
  if (cfg.router === 'slm') {
    const slm = new OllamaRouter({
      baseUrl: cfg.ollamaBaseUrl,
      model: cfg.routerModel,
      logger,
      fallback: new PassthroughRouter(),
    });
    router = slm;
    void slm.warm();
    logger.info('router', { backend: 'slm', model: cfg.routerModel });
  } else if (cfg.router === 'heuristic') {
    router = new HeuristicRouter();
    logger.info('router', { backend: 'heuristic' });
  } else {
    router = new PassthroughRouter();
    logger.info('router', { backend: 'passthrough' });
  }

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
    // 10-second cold start. The user can chat with mock audio
    // fallback while it loads.
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
    tts = new MockTts();
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

  const hub = new Hub();

  // Log high-signal turn events to the server stdout so the live log
  // is actually useful (not just GET /state polling).
  pipeline.bus.on('route.decision', (e) => {
    logger.info('route', { turnId: e.turnId, kind: e.decision.kind, intent: e.decision.intent });
  });
  pipeline.bus.on('turn.complete', (e) => {
    logger.info('turn', {
      id: e.turn.id,
      tier: e.turn.tier,
      intent: e.turn.intent,
      interrupted: e.turn.interrupted,
      userText: e.turn.userText.slice(0, 80),
      agentText: (e.turn.agentText ?? '').slice(0, 120),
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
          model: cfg.backend === 'mock' ? null : cfg.model,
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
          await simulateTranscription(text, turnId);
          const turn = await pipeline.handleTurn(text, { turnId });
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
        : cfg.backend === 'openai'
        ? `openai (${cfg.model} @ ${cfg.openaiBaseUrl})`
        : 'mock';
    const ttsLabel =
      cfg.ttsBackend === 'kokoro'
        ? `kokoro (${cfg.kokoroVoice}, ${cfg.kokoroDtype})`
        : 'web-speech (browser)';
    const routerLabel =
      cfg.router === 'slm' ? `slm (${cfg.routerModel})` : cfg.router;
    process.stdout.write(
      `\n  oasis-echo web is live at http://localhost:${PORT}\n` +
        `  router:   ${routerLabel}\n` +
        `  reasoner: ${reasonerLabel}\n` +
        `  tts:      ${ttsLabel}\n` +
        `  session:  ${cfg.sessionId}\n\n`,
    );
  });
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
