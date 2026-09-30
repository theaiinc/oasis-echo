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
 *   GET  /api/ready             whether speaking and listening have warmed up
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
import { BACKCHANNELS_VI, SharedEars, SharedVoice } from './voice.js';
import { allFillerPhrases } from '@oasis-echo/orchestrator';
import { deskPhrases } from './experts.js';
import { DirFactStore, GcsFactStore } from './memory.js';
import { isVietnamese, VieneuTts } from './vieneu.js';
import type { Live } from './sessions.js';
import type { WhisperStreamingStt } from '@oasis-echo/coordinator';

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
// Kokoro's phonemizer (Emscripten) adds process handlers that rethrow, so one stray
// rejected promise anywhere (a failed model load, a socket) exits the server and every
// call on it. Once Kokoro has loaded, take those out again: log a stray rejection, and
// leave uncaught exceptions to Node's default.
process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { error: String(err) }));
const processHandlers = {
  uncaughtException: process.listeners('uncaughtException'),
  unhandledRejection: process.listeners('unhandledRejection'),
};
// Vietnamese speech: VieNeu-TTS through a Python bridge, when ECHO_VIENEU_PYTHON names the interpreter it's installed in.
const vieneu = env['ECHO_TTS'] !== 'browser' && env['ECHO_VIENEU_PYTHON']
  ? new VieneuTts({ python: env['ECHO_VIENEU_PYTHON'], script: join(here, '..', 'src', 'vieneu-bridge.py'), logger })
  : null;
const voice = env['ECHO_TTS'] === 'browser'
  ? null
  : new SharedVoice({
      logger,
      vi: vieneu,
      phrases: [
        ...allFillerPhrases(),
        ...(vieneu ? [...allFillerPhrases('vi'), ...BACKCHANNELS_VI] : []),
        ...agents.flatMap((a) => (a.expert ? deskPhrases(a.expert.name).filter((p) => vieneu || !isVietnamese(p)) : [])),
      ],
      // Written at image build by dist/bake.js (Dockerfile.hosted).
      bakedFile: env['ECHO_PHRASES_FILE'] ?? fileURLToPath(new URL('../phrases.json', import.meta.url)),
    });
void voice?.ready.then(() => {
  for (const listener of process.listeners('uncaughtException')) {
    if (!processHandlers.uncaughtException.includes(listener)) process.removeListener('uncaughtException', listener);
  }
  for (const listener of process.listeners('unhandledRejection')) {
    if (!processHandlers.unhandledRejection.includes(listener)) process.removeListener('unhandledRejection', listener);
  }
});
const ears = env['ECHO_SERVER_STT'] === '1' ? new SharedEars(logger, undefined, env['ECHO_STT_VI_MODEL'] || null) : null;
// Warm up at start, not on the first call: speaking first, then listening, so a call
// only starts (the page waits on /api/ready) once both are there.
const warm = { voice: !voice, ears: !ears, vi: !vieneu };
// Settled either way: without VieNeu a Vietnamese call still picks up (on Kokoro) rather than ringing forever.
void vieneu?.ready.then(() => { warm.vi = true; });
void (voice?.ready ?? Promise.resolve()).then(() => {
  warm.voice = true;
  return ears?.newListener().preload();
}).then(async () => {
  if (ears?.hasVietnamese) await ears.newListener('vi').preload();
  warm.ears = true;
  logger.info('warm', { ms: Math.round(process.uptime() * 1000) });
  if (vieneu) logger.info('vieneu warm', { ok: await vieneu.ready, ms: Math.round(process.uptime() * 1000) });
});
// Facts users ask to keep: Cloud Storage in production, a directory in development, or none (kept for the call only).
const factStore = env['ECHO_MEMORY_BUCKET'] ? new GcsFactStore(env['ECHO_MEMORY_BUCKET'])
  : env['ECHO_MEMORY_DIR'] ? new DirFactStore(env['ECHO_MEMORY_DIR']) : null;
const sessions = new Sessions({ env, tts: voice, logger, facts: factStore });
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

    if (url.pathname === '/api/ready') {
      // A Vietnamese call also waits for VieNeu; an English one doesn't.
      const vi = (url.searchParams.get('lang') ?? '').toLowerCase().startsWith('vi');
      return json(res, 200, { ready: warm.voice && warm.ears && (!vi || warm.vi), ...warm });
    }
    if (url.pathname === '/api/me') {
      return json(res, 200, {
        email: user.email,
        serverStt: !!ears,
        serverSttLanguages: ears ? (ears.hasVietnamese ? ['en-US', 'vi-VN'] : ['en-US']) : [],
        serverVoice: !!voice,
        agents: agents.filter((a) => canUse(a, user.email)).map((a) => ({
          id: a.id, name: a.name, project: a.project, expert: a.expert?.name ?? null, live: !!talkerFor(a, env),
        })),
      });
    }

    const m = /^\/a\/([a-z0-9-]+)\/(events|turn|bargein|backchannel|lang)$/.exec(url.pathname);
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
      const clip = voice?.backchannel(sessions.get(agent, user).callLanguage());
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
    if (route === 'lang') {
      live.pageLanguage = typeof input['lang'] === 'string' ? input['lang'].slice(0, 20) : null;
      return json(res, 200, { lang: live.callLanguage() });
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
  wss.handleUpgrade(req, socket, head, (ws) => listen(ws, sessions.get(agent, user!)));
});

function listen(ws: WebSocket, live: Live): void {
  // A listener per language, picked at the start of each utterance from the call's language.
  const listeners = new Map<'en' | 'vi', WhisperStreamingStt>();
  const listenerFor = (lang: 'en' | 'vi') => {
    const key = lang === 'vi' && ears!.hasVietnamese ? 'vi' : 'en';
    let l = listeners.get(key);
    if (!l) listeners.set(key, (l = ears!.newListener(key)));
    return l;
  };
  let stt = listenerFor(live.callLanguage());
  let utteranceId: string | null = null;
  const send = (payload: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload)); };
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
      stt = listenerFor(live.callLanguage());
      stt.reset();
      utteranceId = msg.utteranceId ?? `u${Date.now().toString(36)}`;
      // The page only shows "listening…" for a partial, so say so once instead of
      // re-transcribing the whole buffer every few hundred ms: those Whisper passes
      // overlapped on Cloud Run's CPUs and starved the talker and Kokoro (seconds of
      // delay before a reply). The final transcript still comes from transcribeAll().
      send({ type: 'stt.partial', text: '', utteranceId, atMs: Date.now() });
    } else if (msg.type === 'end') {
      const id = utteranceId;
      const started = Date.now();
      void stt.transcribeAll().then((text) => {
        logger.info('stt final', { ms: Date.now() - started, words: text.split(/\s+/).filter(Boolean).length });
        send({ type: 'stt.final', text, utteranceId: id, speculationId: msg.speculationId ?? null, atMs: Date.now() });
        stt.reset();
      }).catch(() => undefined);
    } else if (msg.type === 'abort') {
      stt.reset();
    }
  };
  ws.on('error', (err) => logger.warn('audio socket error', { error: String(err) }));
}

const port = Number(env['PORT'] ?? 8080);
server.listen(port, () => {
  logger.info('echo hosted', { port, publicUrl, agents: agents.map((a) => a.id), voice: voice ? 'kokoro' : 'browser', serverStt: !!ears, devUser: devUser ?? null });
});
