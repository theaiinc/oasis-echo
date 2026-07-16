import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { newDialogueState } from '@oasis-echo/types';
import { OpenAIReasoner } from '../src/openai-client.js';

let currentServer: Server | null = null;

async function startFakeOpenAI(
  handler: (
    write: (line: string) => void,
    end: () => void,
    body: string,
  ) => void | Promise<void>,
): Promise<string> {
  return await new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const write = (line: string) => res.write(line + '\n');
        const end = () => res.end();
        void handler(write, end, body);
      });
    });
    server.listen(0, () => {
      currentServer = server;
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve(`http://127.0.0.1:${addr.port}/v1`);
    });
  });
}

async function startFakeJsonOpenAI(body: unknown, delayMs = 0): Promise<string> {
  return await new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', async () => {
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
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

  it('uses a per-turn model override when provided', async () => {
    let requestBody = '';
    const baseUrl = await startFakeOpenAI((write, end, body) => {
      requestBody = body;
      write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          }),
      );
      write('');
      write('data: [DONE]');
      end();
    });

    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'primary-model' });
    for await (const _ev of reasoner.stream({
      userText: 'medium question',
      state: newDialogueState('s', 0),
      model: 'Qwen_Qwen3-4B-GGUF',
    })) {
      // Drain the stream so the request is sent.
    }

    expect((JSON.parse(requestBody) as { model: string }).model).toBe('Qwen_Qwen3-4B-GGUF');
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

  it('prefills local LM Studio assistant responses by default', async () => {
    let requestBody = '';
    const baseUrl = await startFakeOpenAI((write, end, body) => {
      requestBody = body;
      write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          }),
      );
      write('');
      write('data: [DONE]');
      end();
    });
    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'x' });

    for await (const _ev of reasoner.stream({
      userText: 'reply ok',
      state: newDialogueState('s', 0),
    })) {
      // Drain the stream so the request is sent.
    }

    const messages = (JSON.parse(requestBody) as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages.at(-2)).toEqual({ role: 'user', content: 'reply ok\n/no_think' });
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: ' ' });
  });

  it('instructs local reasoners not to emit hidden thinking by default', async () => {
    let requestBody = '';
    const baseUrl = await startFakeOpenAI((write, end, body) => {
      requestBody = body;
      write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          }),
      );
      write('');
      write('data: [DONE]');
      end();
    });
    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'x' });

    for await (const _ev of reasoner.stream({
      userText: 'reply ok',
      state: newDialogueState('s', 0),
    })) {
      // Drain the stream so the request is sent.
    }

    const messages = (JSON.parse(requestBody) as { messages: Array<{ role: string; content: string }> }).messages;
    const policy = messages.find((message) =>
      message.role === 'system' && message.content.includes('Reasoning policy:'),
    )?.content;
    expect(policy).toContain('Do not output internal thinking');
    expect(policy).toContain('If the user explicitly asks for reasoning');
  });

  it('routes OpenAI-compatible reasoning_content through think tags', async () => {
    const baseUrl = await startFakeOpenAI((write, end) => {
      write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { reasoning_content: 'private reasoning' } }],
          }),
      );
      write('');
      write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: 'Visible answer.' } }],
          }),
      );
      write('');
      write('data: [DONE]');
      end();
    });
    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'x' });
    const tokens: string[] = [];
    for await (const ev of reasoner.stream({
      userText: 'reply',
      state: newDialogueState('s', 0),
    })) {
      if (ev.type === 'token') tokens.push(ev.text);
    }

    expect(tokens.join('')).toContain('<think>private reasoning</think>');
    expect(tokens.join('')).toContain('Visible answer.');
  });

  it('accepts non-streaming JSON completions from local compatible servers', async () => {
    const baseUrl = await startFakeJsonOpenAI({
      choices: [
        {
          message: { content: 'A real answer.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'x' });
    const tokens: string[] = [];
    const doneEvents: Array<{ inputTokens: number; outputTokens: number }> = [];
    for await (const ev of reasoner.stream({
      userText: 'reply',
      state: newDialogueState('s', 0),
    })) {
      if (ev.type === 'token') tokens.push(ev.text);
      if (ev.type === 'done') doneEvents.push(ev);
    }

    expect(tokens.join('')).toBe('A real answer.');
    expect(doneEvents).toMatchObject([{ inputTokens: 3, outputTokens: 4 }]);
  });

  it('emits heartbeats while waiting for delayed non-streaming local completions', async () => {
    const baseUrl = await startFakeJsonOpenAI({
      choices: [
        {
          message: { content: 'Delayed answer.' },
          finish_reason: 'stop',
        },
      ],
    }, 2200);
    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'x' });
    const events: string[] = [];
    for await (const ev of reasoner.stream({
      userText: 'reply',
      state: newDialogueState('s', 0),
    })) {
      events.push(ev.type);
    }

    expect(events).toContain('heartbeat');
    expect(events).toEqual(expect.arrayContaining(['token', 'done']));
  });

  it('strips local llama console echo from JSON completions', async () => {
    const baseUrl = await startFakeJsonOpenAI({
      choices: [
        {
          message: {
            content:
              'Loading model...\n\n> system: prompt\n> user: reply\n/no_think\nassistant:\n\nA clean answer.',
          },
          finish_reason: 'stop',
        },
      ],
    });
    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'x' });
    const tokens: string[] = [];
    for await (const ev of reasoner.stream({
      userText: 'reply',
      state: newDialogueState('s', 0),
    })) {
      if (ev.type === 'token') tokens.push(ev.text);
    }

    expect(tokens.join('')).toBe('A clean answer.');
  });

  it('strips local llama truncated prompt echo from JSON completions', async () => {
    const baseUrl = await startFakeJsonOpenAI({
      choices: [
        {
          message: {
            content:
              'Loading model...\n\navailable commands:\n\n> system: long prompt ... (truncated)\nA clean answer after truncation.',
          },
          finish_reason: 'stop',
        },
      ],
    });
    const reasoner = new OpenAIReasoner({ apiKey: 'test', baseUrl, model: 'x' });
    const tokens: string[] = [];
    for await (const ev of reasoner.stream({
      userText: 'reply',
      state: newDialogueState('s', 0),
    })) {
      if (ev.type === 'token') tokens.push(ev.text);
    }

    expect(tokens.join('')).toBe('A clean answer after truncation.');
  });
});
