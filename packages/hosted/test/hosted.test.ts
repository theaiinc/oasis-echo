import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canUse, loadAgents, makeReasoner, roleFor } from '../src/agents.js';
import { AegisAuth, cookies, sign, unsign } from '../src/auth.js';
import { relay } from '../src/sessions.js';

const MAYA = JSON.stringify([{
  id: 'maya', name: 'Maya', project: 'Pantheon', kind: 'pantheon', baseUrl: 'https://p.example', tokenEnv: 'PANTHEON_BOT_TOKEN',
  allow: ['Steve@Example.com', '*@team.example'], roles: { 'steve@example.com': 'discord:42' },
}]);

describe('agents', () => {
  it('shows an agent only to the people and domains it allows', () => {
    const [maya] = loadAgents(MAYA);
    expect(canUse(maya!, 'steve@example.com')).toBe(true);
    expect(canUse(maya!, 'anyone@team.example')).toBe(true);
    expect(canUse(maya!, 'stranger@example.com')).toBe(false);
    expect(canUse(maya!, 'team.example')).toBe(false);
  });

  it('talks in the mapped conversation, or one of its own per user', () => {
    const [maya] = loadAgents(MAYA);
    expect(roleFor(maya!, { sub: 's1', email: 'Steve@example.com' })).toBe('discord:42');
    expect(roleFor(maya!, { sub: 's2', email: 'amy@team.example' })).toBe('voice:amy@team.example');
  });

  it('refuses a config it cannot run', () => {
    expect(() => loadAgents('[{"id":"x"}]')).toThrow('name is required');
    expect(() => loadAgents(MAYA.replace('"pantheon"', '"other"'))).toThrow('not supported');
    expect(() => loadAgents(MAYA.replace(/"allow":\[[^\]]*\]/, '"allow":[]'))).toThrow('who may use it');
    expect(() => makeReasoner(loadAgents(MAYA)[0]!, { sub: 's', email: 'steve@example.com' }, {})).toThrow('PANTHEON_BOT_TOKEN is not set');
  });
});

describe('sessions', () => {
  it('signs and checks cookies, and expires them', () => {
    const token = sign({ sub: 'a', email: 'a@b', exp: Math.floor(Date.now() / 1000) + 60 }, 'secret');
    expect(unsign(token, 'secret')).toMatchObject({ sub: 'a' });
    expect(unsign(token, 'other')).toBeNull();
    expect(unsign(token.replace(/^./, 'x'), 'secret')).toBeNull();
    expect(unsign(sign({ exp: 1 }, 'secret'), 'secret')).toBeNull();
    expect(cookies('a=1; echo_session=x%3Dy')).toEqual({ a: '1', echo_session: 'x=y' });
  });
});

describe('Aegis id_token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256' };
  const discovery = { issuer: 'https://id.example', authorization_endpoint: 'https://id.example/auth', token_endpoint: 'https://id.example/token', jwks_uri: 'https://id.example/jwks' };
  const fetchImpl = (async (url: string) => new Response(JSON.stringify(url.endsWith('/jwks') ? { keys: [jwk] } : discovery))) as unknown as typeof fetch;
  const auth = new AegisAuth({ issuer: 'https://id.example', clientId: 'echo', clientSecret: 's', redirectUri: 'https://echo.example/auth/callback', sessionSecret: 'x', fetchImpl });
  const jwt = (claims: object, key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = cryptoSign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const good = { iss: 'https://id.example', aud: 'echo', sub: 'u1', email: 'a@b', nonce: 'n', exp: Math.floor(Date.now() / 1000) + 60 };

  it('accepts a token Aegis signed for this client and this sign-in', async () => {
    await expect(auth.verifyIdToken(jwt(good), 'https://id.example', 'n')).resolves.toMatchObject({ sub: 'u1' });
  });

  it('refuses another key, audience, issuer, sign-in, or an expired token', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await expect(auth.verifyIdToken(jwt(good, other), 'https://id.example', 'n')).rejects.toThrow('signature invalid');
    await expect(auth.verifyIdToken(jwt({ ...good, aud: 'pantheon' }), 'https://id.example', 'n')).rejects.toThrow('audience');
    await expect(auth.verifyIdToken(jwt({ ...good, iss: 'https://evil' }), 'https://id.example', 'n')).rejects.toThrow('issuer');
    await expect(auth.verifyIdToken(jwt(good), 'https://id.example', 'other')).rejects.toThrow('nonce');
    await expect(auth.verifyIdToken(jwt({ ...good, exp: 1 }), 'https://id.example', 'n')).rejects.toThrow('expired');
  });

  it('starts sign-in with PKCE and remembers the attempt in a cookie', async () => {
    const { url, cookie } = await auth.start('/');
    const q = new URL(url).searchParams;
    expect(q.get('client_id')).toBe('echo');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe('https://echo.example/auth/callback');
    expect(cookie).toMatch(/^echo_login=.*HttpOnly; Secure; SameSite=Lax/);
  });
});

describe('relay', () => {
  it('passes the page only what it speaks and shows', () => {
    expect(relay({ type: 'tts.chunk', turnId: 't', text: 'Hi.', final: true, filler: false, pcm: new Int16Array(4) } as any))
      .toEqual({ type: 'say', data: { turnId: 't', text: 'Hi.', final: true, filler: false } });
    expect(relay({ type: 'llm.token', token: 'x' } as any)).toBeNull();
  });
});
