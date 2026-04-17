import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockTts } from '@oasis-echo/coordinator';
import { Pipeline } from '@oasis-echo/orchestrator';
import {
  AnthropicReasoner,
  MockReasoner,
  ToolRegistry,
  echoTool,
  timeTool,
  type Reasoner,
} from '@oasis-echo/reasoning';
import { createLogger, Metrics, Tracer } from '@oasis-echo/telemetry';
import { loadConfig } from './config.js';

const PORT = Number(process.env['PORT'] ?? 3000);
const __dirname = dirname(fileURLToPath(import.meta.url));
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
  if (cfg.cloudEnabled) {
    reasoner = new AnthropicReasoner({ logger, tools, model: cfg.model });
    logger.info('reasoner', { backend: 'anthropic', model: cfg.model });
  } else {
    reasoner = new MockReasoner();
    logger.info('reasoner', { backend: 'mock' });
  }

  const pipeline = new Pipeline({
    sessionId: cfg.sessionId,
    reasoner,
    tts: new MockTts(),
    logger,
    metrics,
    tracer: new Tracer(),
  });

  const hub = new Hub();

  // Relay every pipeline event to connected SSE clients.
  pipeline.bus.onAny((event) => {
    if (event.type === 'tts.chunk') {
      const text = new TextDecoder().decode(
        new Uint8Array(event.pcm.buffer, event.pcm.byteOffset, event.pcm.byteLength),
      );
      hub.broadcast('tts.chunk', { turnId: event.turnId, text, final: event.final, atMs: event.atMs });
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
      // Kick off the turn in the background; progress is reported via SSE.
      const turnId = `t-${Date.now().toString(36)}`;
      hub.broadcast('user.input', { turnId, text, atMs: Date.now() });
      void (async () => {
        try {
          await simulateTranscription(text, turnId);
          const turn = await pipeline.handleTurn(text);
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
    process.stdout.write(
      `\n  oasis-echo web is live at http://localhost:${PORT}\n` +
        `  reasoner: ${cfg.cloudEnabled ? `anthropic (${cfg.model})` : 'mock'}\n` +
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
