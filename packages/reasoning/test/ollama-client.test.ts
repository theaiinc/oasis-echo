import { createServer, type Server } from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { newDialogueState } from '@oasis-echo/types';
import { OllamaReasoner } from '../src/ollama-client.js';

let currentServer: Server | null = null;

async function startFakeOllama(
  handler: (body: unknown, write: (line: string) => void, end: () => void) => void | Promise<void>,
): Promise<string> {
  return await new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* empty */
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const write = (line: string) => res.write(line + '\n');
        const end = () => res.end();
        await handler(parsed, write, end);
      });
    });
    server.listen(0, () => {
      currentServer = server;
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve(`http://127.0.0.1:${addr.port}`);
      } else {
        resolve('');
      }
    });
  });
}

afterEach(async () => {
  if (currentServer) {
    await new Promise<void>((r) => currentServer!.close(() => r()));
    currentServer = null;
  }
});

describe('OllamaReasoner', () => {
  it('streams tokens from NDJSON chunks', async () => {
    const baseUrl = await startFakeOllama((_body, write, end) => {
      write(JSON.stringify({ message: { content: 'Hello' } }));
      write(JSON.stringify({ message: { content: ' world' } }));
      write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2 }));
      end();
    });

    const reasoner = new OllamaReasoner({ baseUrl, model: 'test' });
    const events: string[] = [];
    let outputTokens = 0;
    for await (const ev of reasoner.stream({
      userText: 'hi',
      state: newDialogueState('s', 0),
    })) {
      if (ev.type === 'token') events.push(ev.text);
      if (ev.type === 'done') outputTokens = ev.outputTokens;
    }
    expect(events.join('')).toBe('Hello world');
    expect(outputTokens).toBe(2);
  });

  it('rehydrates redacted PII in streamed tokens', async () => {
    const baseUrl = await startFakeOllama((_body, write, end) => {
      write(JSON.stringify({ message: { content: 'Email sent to <EMAIL_1>.' } }));
      write(JSON.stringify({ done: true }));
      end();
    });

    const reasoner = new OllamaReasoner({ baseUrl, model: 'test' });
    const tokens: string[] = [];
    for await (const ev of reasoner.stream({
      userText: 'email alice@example.com the update',
      state: newDialogueState('s', 0),
    })) {
      if (ev.type === 'token') tokens.push(ev.text);
    }
    expect(tokens.join('')).toContain('alice@example.com');
  });

  it('throws when the server returns non-OK', async () => {
    const baseUrl = await startFakeOllama((_body, write, end) => {
      // Send invalid path behavior: reply 200 with unparseable body.
      // We trigger error by crashing JSON parse — but to check non-OK path,
      // intercept with a dedicated server:
      end();
    });
    // swap in a failing server
    await new Promise<void>((r) => currentServer!.close(() => r()));
    currentServer = null;

    const failBase = await new Promise<string>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
      });
      s.listen(0, () => {
        currentServer = s;
        const addr = s.address();
        resolve(typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '');
      });
    });
    void baseUrl;

    const reasoner = new OllamaReasoner({ baseUrl: failBase, model: 'test' });
    await expect(async () => {
      for await (const _ev of reasoner.stream({
        userText: 'hi',
        state: newDialogueState('s', 0),
      })) {
        void _ev;
      }
    }).rejects.toThrow(/ollama 500/);
  });

  it('opens circuit after repeated failures', async () => {
    const failBase = await new Promise<string>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
      });
      s.listen(0, () => {
        currentServer = s;
        const addr = s.address();
        resolve(typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '');
      });
    });

    const reasoner = new OllamaReasoner({ baseUrl: failBase, model: 'test' });
    for (let i = 0; i < 3; i++) {
      try {
        for await (const _ev of reasoner.stream({
          userText: 'x',
          state: newDialogueState('s', 0),
        })) {
          void _ev;
        }
      } catch {
        /* expected */
      }
    }
    expect(reasoner.circuitStatus).toBe('open');
  });
});
