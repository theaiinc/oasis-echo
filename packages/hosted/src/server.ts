/**
 * Hosted Echo: one server, many users and many agents (projects).
 *
 *   GET  /               the talk page (signed in) or a redirect to Aegis
 *   GET  /auth/login     start signing in with Aegis
 *   GET  /auth/callback  back from Aegis
 *   POST /auth/logout
 *   GET  /api/me         who you are and the agents you may talk to
 *   GET  /api/events?agent=ID   server-sent events: what the agent says
 *   POST /api/turn       { agent, text }: something you said
 *   POST /api/bargein    { agent }: you interrupted
 *   GET  /healthz
 *
 * Env: ECHO_AGENTS (see agents.ts) plus each agent's tokenEnv, AEGIS_ISSUER,
 * AEGIS_CLIENT_ID, AEGIS_CLIENT_SECRET, ECHO_PUBLIC_URL, ECHO_SESSION_SECRET.
 * ECHO_DEV_USER=email skips sign-in, outside production only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@oasis-echo/telemetry';
import { canUse, loadAgents, makeReasoner, type AgentConfig, type EchoUser } from './agents.js';
import { AegisAuth, cookie } from './auth.js';
import { Sessions } from './sessions.js';

const env = process.env;
const logger = createLogger({ level: (env['OASIS_LOG_LEVEL'] as 'info') ?? 'info', bindings: { service: 'echo-hosted' } });
const agents = loadAgents(env['ECHO_AGENTS']);
const publicUrl = (env['ECHO_PUBLIC_URL'] ?? `http://localhost:${env['PORT'] ?? 8080}`).replace(/\/+$/, '');
const production = env['NODE_ENV'] === 'production';
const devUser = !production ? env['ECHO_DEV_USER'] : undefined;

const auth = devUser ? null : new AegisAuth({
  issuer: required('AEGIS_ISSUER'),
  clientId: required('AEGIS_CLIENT_ID'),
  clientSecret: required('AEGIS_CLIENT_SECRET'),
  redirectUri: `${publicUrl}/auth/callback`,
  sessionSecret: required('ECHO_SESSION_SECRET'),
});
const sessions = new Sessions((agent, user) => makeReasoner(agent, user, env, logger), logger);
const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'talk.html'), 'utf8');

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function whoIs(req: IncomingMessage): EchoUser | null {
  if (devUser) return { sub: `dev:${devUser}`, email: devUser.toLowerCase() };
  return auth!.session(req.headers.cookie);
}

function agentsFor(user: EchoUser): AgentConfig[] {
  return agents.filter((a) => canUse(a, user.email));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_000) throw new Error('too large');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** A POST that changes something must come from this site (SameSite cookies, plus this). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || origin === publicUrl || (!production && origin.startsWith('http://localhost'));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', publicUrl);
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, sessions: sessions.size });

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
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    if (!user) return json(res, 401, { error: 'sign_in' });

    if (url.pathname === '/api/me') {
      return json(res, 200, { email: user.email, agents: agentsFor(user).map(({ id, name, project }) => ({ id, name, project })) });
    }

    const agentId = req.method === 'GET' ? url.searchParams.get('agent') : null;
    const input = req.method === 'POST' ? await body(req) : {};
    const agent = agentsFor(user).find((a) => a.id === (agentId ?? input['agent']));
    if (!agent) return json(res, 404, { error: 'no_such_agent' });

    if (url.pathname === '/api/events' && req.method === 'GET') {
      const live = sessions.get(agent, user);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: ready\ndata: {}\n\n`);
      live.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ping);
        live.clients.delete(res);
      });
      return;
    }
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, 403, { error: 'forbidden' });

    if (url.pathname === '/api/turn') {
      const text = typeof input['text'] === 'string' ? input['text'].trim().slice(0, 2000) : '';
      if (!text) return json(res, 400, { error: 'empty' });
      const live = sessions.get(agent, user);
      // The answer arrives on /api/events; a new turn interrupts the one before.
      void live.pipeline.bargeIn()
        .then(() => live.pipeline.handleTurn(text))
        .catch((err) => logger.warn('turn failed', { agent: agent.id, error: String(err) }));
      return json(res, 202, { accepted: true });
    }
    if (url.pathname === '/api/bargein') {
      const interrupted = await sessions.get(agent, user).pipeline.bargeIn();
      return json(res, 200, { interrupted });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    logger.error('request failed', { path: url.pathname, error: String(err) });
    if (!res.headersSent) json(res, 500, { error: 'server_error' });
    else res.end();
  }
});

const port = Number(env['PORT'] ?? 8080);
server.listen(port, () => {
  logger.info('echo hosted', { port, publicUrl, agents: agents.map((a) => a.id), devUser: devUser ?? null });
});
