/**
 * Hosted Echo: one server, many users and many agents (projects), live
 * streaming voice. The page uses oasis-echo's own browser SDK against a
 * per-agent base path, so each agent looks like the single-user dev server:
 *
 *   GET  /a/:agent/events       server-sent events (tts.chunk with PCM, turn.complete, …)
 *   POST /a/:agent/turn         { text } something you said ({ partial: true } is ignored)
 *   POST /a/:agent/bargein      you talked over it
 *   GET  /a/:agent/backchannel  a short "mm-hmm" clip
 *   WS   /a/:agent/audio        mic PCM (16 kHz float) → stt.partial / stt.final (optional server listening)
 *   GET  /api/me                who you are and your agents
 *   GET  /sdk/*                 the SDK's browser modules
 *   GET  /                      the call page; /auth/* signs in with Aegis
 *
 * Env: ECHO_AGENTS (agents.ts), ECHO_TALKER_* and the keys they name,
 * AEGIS_ISSUER, AEGIS_CLIENT_ID, AEGIS_CLIENT_SECRET, ECHO_PUBLIC_URL,
 * ECHO_SESSION_SECRET, ECHO_TTS=kokoro|browser (default kokoro),
 * ECHO_SERVER_STT=1 to offer Whisper listening. ECHO_DEV_USER=email skips
 * sign-in outside production.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from '@oasis-echo/telemetry';
import { canUse, loadAgents, talkerFor, type AgentConfig, type EchoUser } from './agents.js';
import { AegisAuth, cookie } from './auth.js';
import { Sessions } from './sessions.js';
import { SharedEars, SharedVoice } from './voice.js';

const env = process.env;
const logger = createLogger({ level: (env['OASIS_LOG_LEVEL'] as 'info') ?? 'info', bindings: { service: 'echo-hosted' } });
const agents = loadAgents(env['ECHO_AGENTS']);
const publicUrl = (env['ECHO_PUBLIC_URL'] ?? `http://localhost:${env['PORT'] ?? 8080}`).replace(/\/+$/, '');
const production = env['NODE_ENV'] === 'production';
const devUser = !production ? env['ECHO_DEV_USER'] : undefined;
const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = normalize(join(here, '..', '..', 'sdk', 'dist'));

const auth = devUser ? null : new AegisAuth({
  issuer: required('AEGIS_ISSUER'),
  clientId: required('AEGIS_CLIENT_ID'),
  clientSecret: required('AEGIS_CLIENT_SECRET'),
  redirectUri: `${publicUrl}/auth/callback`,
  sessionSecret: required('ECHO_SESSION_SECRET'),
});
const voice = env['ECHO_TTS'] === 'browser' ? null : new SharedVoice({ logger });
const ears = env['ECHO_SERVER_STT'] === '1' ? new SharedEars(logger) : null;
const sessions = new Sessions({ env, tts: voice, logger });
const page = readFileSync(join(here, '..', 'src', 'talk.html'), 'utf8');

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function whoIs(req: IncomingMessage): EchoUser | null {
  if (devUser) return { sub: `dev:${devUser}`, email: devUser.toLowerCase() };
  return auth!.session(req.headers.cookie);
}

function agentFor(user: EchoUser, id: string | undefined): AgentConfig | undefined {
  return agents.find((a) => a.id === id && canUse(a, user.email));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error('too large');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** A POST that changes something must come from this site (SameSite cookies, plus this). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || origin === publicUrl || (!production && /^http:\/\/localhost(:\d+)?$/.test(origin));
}

function serveSdk(path: string, res: ServerResponse): void {
  const file = normalize(join(sdkDir, path.replace(/^\/sdk\//, '')));
  if (!file.startsWith(sdkDir + '/') || !file.endsWith('.js')) return json(res, 404, { error: 'not_found' });
  try {
    statSync(file);
  } catch {
    return json(res, 404, { error: 'not_found' });
  }
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', publicUrl);
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, sessions: sessions.size });
    if (url.pathname.startsWith('/sdk/')) return serveSdk(url.pathname, res);

    if (url.pathname === '/auth/login' && auth) {
      const { url: to, cookie: c } = await auth.start(url.searchParams.get('next') ?? '/');
      res.writeHead(302, { location: to, 'set-cookie': c });
      return res.end();
    }
    if (url.pathname === '/auth/callback' && auth) {
      try {
        const done = await auth.finish(url.searchParams, req.headers.cookie);
        logger.info('signed in', { email: done.session.email });
        res.writeHead(302, { location: done.next, 'set-cookie': [done.cookie, cookie('echo_login', '', 0)] });
      } catch (err) {
        logger.warn('sign-in failed', { error: String(err) });
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}\nGo back and try again.`);
      }
      return res.end();
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      res.writeHead(204, { 'set-cookie': cookie('echo_session', '', 0) });
      return res.end();
    }

    const user = whoIs(req);
    if (url.pathname === '/') {
      if (!user) {
        res.writeHead(302, { location: '/auth/login' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page);
    }
    if (!user) return json(res, 401, { error: 'sign_in' });

    if (url.pathname === '/api/me') {
      return json(res, 200, {
        email: user.email,
        serverStt: !!ears,
        serverVoice: !!voice,
        agents: agents.filter((a) => canUse(a, user.email)).map((a) => ({
          id: a.id, name: a.name, project: a.project, expert: a.expert?.name ?? null, live: !!talkerFor(a, env),
        })),
      });
    }

    const m = /^\/a\/([a-z0-9-]+)\/(events|turn|bargein|backchannel)$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: 'not_found' });
    const agent = agentFor(user, m[1]);
    if (!agent) return json(res, 404, { error: 'no_such_agent' });
    const route = m[2];

    if (route === 'events' && req.method === 'GET') {
      const live = sessions.get(agent, user);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': connected\n\n');
      live.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        live.clients.delete(res);
      });
      return;
    }
    if (route === 'backchannel' && req.method === 'GET') {
      const clip = voice?.backchannel();
      return clip ? json(res, 200, { ready: true, ...clip }) : json(res, 503, { ready: false });
    }
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
    const input = await body(req);
    const live = sessions.get(agent, user);

    if (route === 'turn') {
      // Speculative partials are an optimisation this server doesn't run.
      if (input['partial'] === true) return json(res, 202, { accepted: true });
      const text = typeof input['text'] === 'string' ? input['text'].trim().slice(0, 2000) : '';
      if (!text) return json(res, 400, { error: 'empty' });
      void live.turn(text).catch((err) => logger.warn('turn failed', { agent: agent.id, error: String(err) }));
      return json(res, 202, { accepted: true });
    }
    if (route === 'bargein') {
      return json(res, 200, { interrupted: await live.pipeline.bargeIn() });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    logger.error('request failed', { path: url.pathname, error: String(err) });
    if (!res.headersSent) json(res, 500, { error: 'server_error' });
    else res.end();
  }
});

// Optional server listening: the SDK's AudioStreamUpload protocol.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', publicUrl);
  const m = /^\/a\/([a-z0-9-]+)\/audio$/.exec(url.pathname);
  const user = whoIs(req);
  const agent = m && user ? agentFor(user, m[1]) : undefined;
  if (!ears || !agent || !sameOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => listen(ws));
});

function listen(ws: WebSocket): void {
  const stt = ears!.newListener();
  let utteranceId: string | null = null;
  let loop: ReturnType<typeof setInterval> | null = null;
  let last = '';
  const send = (payload: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload)); };
  const stopLoop = () => { if (loop) clearInterval(loop); loop = null; };
  void stt.preload().then(() => send({ type: 'ready' }));
  // Kokoro's phonemizer turns any uncaught exception into a crash of the
  // whole server, so nothing from a socket may throw out of here.
  ws.on('message', (data, isBinary) => {
    try {
      onMessage(data as Buffer, isBinary);
    } catch (err) {
      logger.warn('audio message failed', { error: String(err) });
    }
  });
  const onMessage = (data: Buffer, isBinary: boolean): void => {
    if (isBinary) {
      // 32-bit float PCM; copied so it is aligned whatever Buffer it came in.
      const samples = new Float32Array(Math.floor(data.byteLength / 4));
      new Uint8Array(samples.buffer).set(data.subarray(0, samples.byteLength));
      stt.feed(samples);
      return;
    }
    let msg: { type?: string; speculationId?: string; utteranceId?: string };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'start') {
      stt.reset();
      last = '';
      utteranceId = msg.utteranceId ?? `u${Date.now().toString(36)}`;
      stopLoop();
      loop = setInterval(() => void stt.partial().then((p) => {
        if (p !== null && p !== last) { last = p; send({ type: 'stt.partial', text: p, utteranceId, atMs: Date.now() }); }
      }).catch(() => undefined), 400);
    } else if (msg.type === 'end') {
      stopLoop();
      const id = utteranceId;
      void stt.transcribeAll().then((text) => {
        send({ type: 'stt.final', text, utteranceId: id, speculationId: msg.speculationId ?? null, atMs: Date.now() });
        stt.reset();
      }).catch(() => undefined);
    } else if (msg.type === 'abort') {
      stopLoop();
      stt.reset();
    }
  };
  ws.on('error', (err) => logger.warn('audio socket error', { error: String(err) }));
  ws.on('close', stopLoop);
}

const port = Number(env['PORT'] ?? 8080);
server.listen(port, () => {
  logger.info('echo hosted', { port, publicUrl, agents: agents.map((a) => a.id), voice: voice ? 'kokoro' : 'browser', serverStt: !!ears, devUser: devUser ?? null });
});
