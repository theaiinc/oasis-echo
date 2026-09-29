import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import type { EchoUser } from './agents.js';

/**
 * Sign-in with Aegis (OpenID Connect, authorization code + PKCE), then a
 * signed session cookie. No session store: the cookie carries who you are
 * and when that expires, signed with ECHO_SESSION_SECRET.
 */
export type AuthConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Where Aegis sends the browser back: {public url}/auth/callback */
  redirectUri: string;
  sessionSecret: string;
  sessionHours?: number;
  fetchImpl?: typeof fetch;
};

const b64u = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function sign(value: object, secret: string): string {
  const body = b64u(JSON.stringify(value));
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function unsign<T>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { exp?: number };
    if (typeof value.exp === 'number' && value.exp * 1000 < Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}

export function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };
type PendingLogin = { state: string; verifier: string; nonce: string; next: string; exp: number };
export type Session = EchoUser & { exp: number };

export class AegisAuth {
  private discovery: Promise<Discovery> | null = null;
  private jwks: { keys: Array<JsonWebKey & { kid?: string; alg?: string }> } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: AuthConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= this.fetchImpl(`${this.cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
      .then((r) => {
        if (!r.ok) throw new Error(`Aegis discovery ${r.status}`);
        return r.json() as Promise<Discovery>;
      })
      .catch((err) => {
        this.discovery = null;
        throw err;
      });
    return this.discovery;
  }

  /** Where to send the browser, and the cookie that remembers this attempt. */
  async start(next: string): Promise<{ url: string; cookie: string }> {
    const d = await this.discover();
    const pending: PendingLogin = {
      state: b64u(randomBytes(16)),
      verifier: b64u(randomBytes(32)),
      nonce: b64u(randomBytes(16)),
      next: next.startsWith('/') && !next.startsWith('//') ? next : '/',
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: b64u(createHash('sha256').update(pending.verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), cookie: cookie('echo_login', sign(pending, this.cfg.sessionSecret), 600) };
  }

  /** Back from Aegis: the signed-in user, their session cookie, and where they were going. */
  async finish(query: URLSearchParams, cookieHeader: string | undefined): Promise<{ session: Session; cookie: string; next: string }> {
    const pending = unsign<PendingLogin>(cookies(cookieHeader)['echo_login'], this.cfg.sessionSecret);
    if (!pending) throw new Error('sign-in expired; start again');
    if (query.get('error')) throw new Error(`Aegis: ${query.get('error')}`);
    if (query.get('state') !== pending.state) throw new Error('sign-in state mismatch');
    const code = query.get('code');
    if (!code) throw new Error('no code from Aegis');
    const d = await this.discover();
    const res = await this.fetchImpl(d.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri, code_verifier: pending.verifier }),
    });
    if (!res.ok) throw new Error(`Aegis token exchange ${res.status}`);
    const { id_token } = (await res.json()) as { id_token?: string };
    if (!id_token) throw new Error('Aegis returned no id_token');
    const claims = await this.verifyIdToken(id_token, d.issuer, pending.nonce);
    if (typeof claims['email'] !== 'string' || !claims['email']) throw new Error('your Aegis account has no email');
    const session: Session = {
      sub: String(claims['sub']),
      email: String(claims['email']).toLowerCase(),
      exp: Math.floor(Date.now() / 1000) + (this.cfg.sessionHours ?? 12) * 3600,
    };
    return {
      session,
      cookie: cookie('echo_session', sign(session, this.cfg.sessionSecret), (this.cfg.sessionHours ?? 12) * 3600),
      next: pending.next,
    };
  }

  session(cookieHeader: string | undefined): Session | null {
    return unsign<Session>(cookies(cookieHeader)['echo_session'], this.cfg.sessionSecret);
  }

  async verifyIdToken(jwt: string, issuer: string, nonce: string): Promise<Record<string, unknown>> {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) throw new Error('malformed id_token');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string; kid?: string };
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    const jwk = await this.key(header.kid);
    const data = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, 'base64url');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = header.alg === 'RS256' ? verify('sha256', data, key, sig)
      : header.alg === 'ES256' ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
      : header.alg === 'EdDSA' ? verify(null, data, key, sig)
      : false;
    if (!ok) throw new Error(`id_token signature invalid (${header.alg})`);
    const aud = Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']];
    if (claims['iss'] !== issuer) throw new Error('id_token issuer mismatch');
    if (!aud.includes(this.cfg.clientId)) throw new Error('id_token audience mismatch');
    if (typeof claims['exp'] !== 'number' || claims['exp'] * 1000 < Date.now() - 60_000) throw new Error('id_token expired');
    if (claims['nonce'] !== nonce) throw new Error('id_token nonce mismatch');
    return claims;
  }

  private async key(kid: string | undefined): Promise<JsonWebKey> {
    const find = () => this.jwks?.keys.find((k) => !kid || k.kid === kid);
    if (!find()) {
      const d = await this.discover();
      const res = await this.fetchImpl(d.jwks_uri);
      if (!res.ok) throw new Error(`Aegis JWKS ${res.status}`);
      this.jwks = (await res.json()) as typeof this.jwks;
    }
    const k = find();
    if (!k) throw new Error('id_token signed with an unknown key');
    return k;
  }
}
