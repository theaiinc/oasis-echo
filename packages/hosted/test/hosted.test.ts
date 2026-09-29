import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canUse, loadAgents, makeReasoner, roleFor, talkerFor } from '../src/agents.js';
import { AegisAuth, cookies, sign, unsign } from '../src/auth.js';
import { wire } from '../src/sessions.js';
import { ExpertDesk, LatencyEstimate, lateNote } from '../src/experts.js';

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
    expect(roleFor(maya!.expert!, { sub: 's1', email: 'Steve@example.com' })).toBe('discord:42');
    expect(roleFor(maya!.expert!, { sub: 's2', email: 'amy@team.example' })).toBe('voice:amy@team.example');
  });

  it('refuses a config it cannot run', () => {
    expect(() => loadAgents('[{"id":"x"}]')).toThrow('name is required');
    expect(() => loadAgents(MAYA.replace('"pantheon"', '"other"'))).toThrow('not supported');
    expect(() => loadAgents(MAYA.replace(/"allow":\[[^\]]*\]/, '"allow":[]'))).toThrow('who may use it');
    expect(() => makeReasoner(loadAgents(MAYA)[0]!, { sub: 's', email: 'steve@example.com' }, {})).toThrow('PANTHEON_BOT_TOKEN is not set');
  });

  it('reads the flat form as the expert, and takes the talker from the deployment', () => {
    const [maya] = loadAgents(MAYA);
    expect(maya!.expert).toMatchObject({ kind: 'pantheon', name: 'Maya', tokenEnv: 'PANTHEON_BOT_TOKEN' });
    expect(talkerFor(maya!, {})).toBeNull();
    expect(talkerFor(maya!, { ECHO_TALKER_MODEL: 'fast', ECHO_TALKER_TOKEN_ENV: 'K', K: 'key' }))
      .toEqual({ baseUrl: 'https://api.llmapi.ai/v1', model: 'fast', tokenEnv: 'K', apiKey: 'key' });
    expect(talkerFor(maya!, { ECHO_TALKER_MODEL: 'zaya1-8b', ECHO_TALKER_FALLBACK_MODEL: 'gemini-2.5-flash-lite', ECHO_TALKER_TOKEN_ENV: 'K', K: 'key' }))
      .toMatchObject({ model: 'zaya1-8b', fallbackModel: 'gemini-2.5-flash-lite' });
    const [solo] = loadAgents('[{"id":"chat","name":"Chat","project":"Echo","allow":["*@x.io"]}]');
    expect(solo!.expert).toBeUndefined();
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

describe('wire', () => {
  it('sends speech as base64 PCM the SDK plays', () => {
    const out = wire({ type: 'tts.chunk', turnId: 't', text: 'Hi.', final: true, sampleRate: 24000, atMs: 1, pcm: new Int16Array([1, -1]) } as any) as any;
    expect(out).toMatchObject({ turnId: 't', text: 'Hi.', sampleRate: 24000, filler: false });
    expect(Buffer.from(out.audio, 'base64')).toHaveLength(4);
    expect(wire({ type: 'turn.complete', turn: { id: 't' } } as any)).toEqual({ type: 'turn.complete', turn: { id: 't' } });
  });
});

describe('asking the expert in the background', () => {
  it('estimates from real answers: the median, starting from the prior', () => {
    const est = new LatencyEstimate(60_000);
    expect(est.typicalMs()).toBe(60_000);
    [40_000, 90_000, 50_000].forEach((ms) => est.record(ms));
    expect(est.typicalMs()).toBe(50_000);
    expect(est.slowMs()).toBe(90_000);
  });

  it('answers at once with an ETA, reports late, then delivers the answer', async () => {
    let clock = 0;
    let release!: (answer: string) => void;
    const answered: any[] = [];
    const late: number[] = [];
    const desk = new ExpertDesk('Maya', () => new Promise<string>((r) => { release = r; }), new LatencyEstimate(20), {
      answered: (job) => answered.push(job),
      late: (_job, over) => late.push(over),
    }, () => clock);
    const first = desk.start('What needs attention?');
    expect(first).toMatchObject({ etaSeconds: 0, alreadyAsked: false });
    expect(desk.start('what needs attention')).toMatchObject({ alreadyAsked: true });
    expect(desk.contextNote()).toContain('Maya is working on "What needs attention?"');
    await new Promise((r) => setTimeout(r, 30));
    expect(late).toHaveLength(1);
    clock = 45;
    release('Arion One.');
    await new Promise((r) => setTimeout(r, 5));
    expect(answered[0]).toMatchObject({ status: 'done', answer: 'Arion One.' });
    expect(desk.estimate.typicalMs()).toBe(45);
    expect(desk.contextNote()).toContain('Maya answered "What needs attention?": Arion One.');
    expect(lateNote('Maya', 30_000, 1)).toContain('longer than usual');
  });
});
