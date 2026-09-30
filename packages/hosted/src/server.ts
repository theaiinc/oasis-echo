/**
 * Hosted Echo: one server, many users and many agents (projects), live
 * streaming voice. The page uses oasis-echo's own browser SDK against a
 * per-agent base path, so each agent looks like the single-user dev server:
 *
 *   GET  /a/:agent/events       server-sent events (tts.chunk with PCM, turn.complete, …)
 *   POST /a/:agent/turn         { text } something you said ({ partial: true } is ignored)
 *   POST /a/:agent/bargein      you talked over it
 *   POST /a/:agent/hello        the call picked up: the agent says hello
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
import { DirFactStore, GcsFactStore } from './memory.js';
import { VieneuTts } from './vieneu.js';
import { endpointMs, SpeechGate } from './endpoint.js';
import { greeting, type Live } from './sessions.js';
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
// Greetings carry the agent's name, so they're made here (a few seconds), not baked.
const greetings = (lang: 'en' | 'vi') => agents.map((a) => greeting(a.name, lang));
const warm = { voice: !voice, ears: !ears, vi: !vieneu };
// VieNeu starts only when a page asks for Vietnamese (see /api/ready and /lang). Settled
// either way: without it a Vietnamese call still picks up (on Kokoro) rather than ringing.
vieneu?.whenReady((ok) => {
  void ((ok && voice?.prepare(greetings('vi'))) || Promise.resolve()).then(() => {
    warm.vi = true;
    logger.info('vieneu warm', { ok, ms: Math.round(process.uptime() * 1000) });
  });
});
void (voice?.ready ?? Promise.resolve()).then(async () => {
  await voice?.prepare(greetings('en'));
  warm.voice = true;
  return ears?.newListener().preload();
}).then(async () => {
  if (ears?.hasVietnamese) await ears.newListener('vi').preload();
  warm.ears = true;
  logger.info('warm', { ms: Math.round(process.uptime() * 1000) });
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
      if (vi) void vieneu?.ready; // start VieNeu for this call
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

    const m = /^\/a\/([a-z0-9-]+)\/(events|turn|bargein|backchannel|lang|hello)$/.exec(url.pathname);
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
      // Already started by the server when it heard it (listen()): don't answer twice.
      if (live.alreadyClaimed(typeof input['speculationId'] === 'string' ? input['speculationId'] : null)) return json(res, 202, { accepted: true, duplicate: true });
      void live.turn(text).catch((err) => logger.warn('turn failed', { agent: agent.id, error: String(err) }));
      return json(res, 202, { accepted: true });
    }
    if (route === 'lang') {
      live.pageLanguage = typeof input['lang'] === 'string' ? input['lang'].slice(0, 20) : null;
      if (live.callLanguage() === 'vi') void vieneu?.ready;
      return json(res, 200, { lang: live.callLanguage() });
    }
    if (route === 'hello') {
      live.greet();
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
  let speculationId: string | null = null;
  // The server decides when a turn ends, from the words: once the user has been quiet
  // for EARLY_MS it transcribes, then answers after endpointMs(text) of quiet in all
  // (short after a question, long mid-thought). Speech in the meantime cancels that;
  // speech after the answer started stops it and is joined to what was said before.
  // The page's own end-of-utterance is a fallback.
  const EARLY_MS = 300;
  const BARGE_MS = 250;
  const gate = new SpeechGate();
  // Audio time of the speech an early transcript covers; later speech makes it stale.
  let lastLoudAt = 0;
  let loudAfterCommitMs = 0;
  let early: Promise<string> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let committed = false;
  let carry = '';
  const send = (payload: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload)); };
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const commit = (text: string, how: string, sttMs: number) => {
    clearTimer();
    committed = true;
    loudAfterCommitMs = 0;
    const full = [carry, text.trim()].filter(Boolean).join(' ');
    logger.info('stt final', { ms: sttMs, how, quietMs: Math.round(gate.quietMs), words: full.split(/\s+/).filter(Boolean).length });
    // Start the turn here rather than wait for the page to post it back; the page's
    // own post of this utterance is then ignored (see /turn).
    if (full) {
      live.claimUtterance(speculationId);
      void live.turn(full).catch((err) => logger.warn('turn failed', { error: String(err) }));
    }
    send({ type: 'stt.final', text: full, utteranceId, speculationId, atMs: Date.now() });
    carry = full;
    stt.reset();
    early = null;
    gate.reset();
  };
  const reset = () => {
    clearTimer();
    stt.reset();
    early = null;
    gate.reset();
    committed = false;
    carry = '';
  };
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
      const now = Date.now();
      if (gate.push(samples)) {
        if (committed) {
          // Talking again after the answer started: past a short blip, stop it and keep listening.
          loudAfterCommitMs += 30; // one confirmed 30 ms speech window
          if (loudAfterCommitMs < BARGE_MS) return;
          committed = false;
          void live.pipeline.bargeIn();
        }
        lastLoudAt = gate.lastSpeechMs;
        early = null; // more speech: an early transcript would miss it
        clearTimer();
      } else if (gate.spoke && !committed && !early && gate.quietMs >= EARLY_MS) {
        const at = lastLoudAt;
        const started = now;
        const pending = stt.transcribeAll();
        early = pending;
        pending.then((text) => {
          if (early !== pending || lastLoudAt !== at || committed) return;
          if (!text.trim()) return; // nothing heard: leave it to the page's end
          const wait = endpointMs([carry, text].filter(Boolean).join(' '));
          timer = setTimeout(() => {
            if (early === pending && lastLoudAt === at && !committed) commit(text, `endpoint ${wait}ms`, Date.now() - started);
          }, Math.max(0, wait - gate.quietMs));
        }).catch(() => undefined);
      }
      return;
    }
    let msg: { type?: string; speculationId?: string; utteranceId?: string };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'start') {
      stt = listenerFor(live.callLanguage());
      reset();
      utteranceId = msg.utteranceId ?? `u${Date.now().toString(36)}`;
      speculationId = msg.speculationId ?? null;
      // The page only shows "listening…" for a partial, so say so once instead of
      // re-transcribing the whole buffer every few hundred ms (those passes starved
      // the talker and Kokoro on Cloud Run's CPUs).
      send({ type: 'stt.partial', text: '', utteranceId, atMs: Date.now() });
    } else if (msg.type === 'end') {
      // The page's fallback end: answer now unless the server already did.
      // (Even if the server never heard it as loud: a quiet mic must still get an answer.)
      if (committed) return;
      const started = Date.now();
      void (early ?? stt.transcribeAll()).then((text) => {
        if (!committed) commit(text, 'page end', Date.now() - started);
      }).catch(() => undefined);
    } else if (msg.type === 'abort') {
      reset();
    }
  };
  ws.on('error', (err) => logger.warn('audio socket error', { error: String(err) }));
}

const port = Number(env['PORT'] ?? 8080);
server.listen(port, () => {
  logger.info('echo hosted', { port, publicUrl, agents: agents.map((a) => a.id), voice: voice ? 'kokoro' : 'browser', serverStt: !!ears, devUser: devUser ?? null });
});
