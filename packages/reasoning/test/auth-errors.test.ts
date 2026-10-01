import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { newDialogueState } from '@oasis-echo/types';
import { AnthropicReasoner } from '../src/anthropic-client.js';
import { isReasonerAuthError, ReasonerAuthError } from '../src/errors.js';
import { OpenAIReasoner } from '../src/openai-client.js';
import type { Reasoner } from '../src/anthropic-client.js';

let currentServer: Server | null = null;
let requests = 0;

/** Fake provider that answers every request with `status` + a JSON error body. */
async function startStatusServer(status: number): Promise<string> {
  requests = 0;
  return await new Promise((resolve) => {
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      });
    });
    server.listen(0, () => {
      currentServer = server;
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function drain(reasoner: Reasoner): Promise<unknown> {
  try {
    for await (const _ of reasoner.stream({ userText: 'hi', state: newDialogueState('s', 0) })) {
      // consume
    }
    return null;
  } catch (err) {
    return err;
  }
}

afterEach(async () => {
  delete process.env['ANTHROPIC_BASE_URL'];
  if (currentServer) {
    await new Promise<void>((r) => currentServer!.close(() => r()));
    currentServer = null;
  }
});

describe('reasoner auth errors', () => {
  for (const status of [401, 403]) {
    it(`OpenAIReasoner raises ReasonerAuthError on ${status} without tripping the breaker`, async () => {
      const base = await startStatusServer(status);
      const reasoner = new OpenAIReasoner({ apiKey: 'test-key', baseUrl: `${base}/v1`, model: 'x' });
      for (let i = 0; i < 4; i++) {
        const err = await drain(reasoner);
        expect(isReasonerAuthError(err)).toBe(true);
        expect(err).toBeInstanceOf(ReasonerAuthError);
        expect((err as ReasonerAuthError).status).toBe(status);
        expect((err as Error).message).toContain('API key rejected');
      }
      expect(reasoner.circuitStatus).toBe('closed');
      expect(requests).toBe(4);
    });
  }

  it('OpenAIReasoner still trips the breaker on transient 5xx errors', async () => {
    const base = await startStatusServer(503);
    const reasoner = new OpenAIReasoner({ apiKey: 'test-key', baseUrl: `${base}/v1`, model: 'x' });
    for (let i = 0; i < 3; i++) {
      const err = await drain(reasoner);
      expect(isReasonerAuthError(err)).toBe(false);
    }
    expect(reasoner.circuitStatus).toBe('open');
  });

  for (const status of [401, 403]) {
    it(`AnthropicReasoner raises ReasonerAuthError on ${status} without retrying or tripping the breaker`, async () => {
      process.env['ANTHROPIC_BASE_URL'] = await startStatusServer(status);
      const reasoner = new AnthropicReasoner({ apiKey: 'test-key' });
      for (let i = 0; i < 4; i++) {
        const err = await drain(reasoner);
        expect(isReasonerAuthError(err)).toBe(true);
        expect((err as ReasonerAuthError).provider).toBe('anthropic');
        expect((err as ReasonerAuthError).status).toBe(status);
      }
      expect(reasoner.circuitStatus).toBe('closed');
      // One HTTP request per attempt: the SDK does not retry 401/403.
      expect(requests).toBe(4);
    });
  }
});
