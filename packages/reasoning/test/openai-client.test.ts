import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { newDialogueState } from '@oasis-echo/types';
import { OpenAIReasoner } from '../src/openai-client.js';

let currentServer: Server | null = null;

async function startFakeOpenAI(
  handler: (write: (line: string) => void, end: () => void) => void | Promise<void>,
): Promise<string> {
  return await new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (line: string) => res.write(line + '\n');
      const end = () => res.end();
      void handler(write, end);
    });
    server.listen(0, () => {
      currentServer = server;
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve(`http://127.0.0.1:${addr.port}/v1`);
    });
  });
}

afterEach(async () => {
  if (currentServer) {
    await new Promise<void>((r) => currentServer!.close(() => r()));
    currentServer = null;
  }
});

describe('OpenAIReasoner', () => {
  it('streams tokens from SSE deltas', async () => {
    const baseUrl = await startFakeOpenAI((write, end) => {
      const send = (content: string, finish?: string) => {
        write(
          'data: ' +
            JSON.stringify({
              choices: [{ delta: { content }, finish_reason: finish }],
            }),
        );
        write('');
      };
      send('Hello');
      send(' world');
      send('', 'stop');
      write('data: [DONE]');
      end();
    });

    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'x' });
    const tokens: string[] = [];
    let done = false;
    for await (const ev of reasoner.stream({
      userText: 'hi',
      state: newDialogueState('s', 0),
    })) {
      if (ev.type === 'token') tokens.push(ev.text);
      if (ev.type === 'done') done = true;
    }
    expect(tokens.join('')).toBe('Hello world');
    expect(done).toBe(true);
  });

  it('rehydrates redacted PII across the stream', async () => {
    const baseUrl = await startFakeOpenAI((write, end) => {
      write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: 'Sending to <EMAIL_1>.' } }],
          }),
      );
      write('');
      write('data: [DONE]');
      end();
    });
    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'x' });
    const tokens: string[] = [];
    for await (const ev of reasoner.stream({
      userText: 'send to alice@example.com',
      state: newDialogueState('s', 0),
    })) {
      if (ev.type === 'token') tokens.push(ev.text);
    }
    expect(tokens.join('')).toContain('alice@example.com');
  });
});
