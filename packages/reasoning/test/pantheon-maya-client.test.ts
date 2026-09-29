import { describe, expect, it, vi } from 'vitest';
import { PantheonMayaReasoner, replyAfter, spokenText } from '../src/pantheon-maya-client.js';

async function collect(it: AsyncIterable<unknown>) {
  const out: any[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('PantheonMayaReasoner', () => {
  it("sends the turn to Maya's chat as the bot, under the role, and speaks her reply", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      messages: [
        { id: '1', role: 'user', text: 'old' },
        { id: '2', role: 'assistant', text: 'old answer' },
        { id: '3', role: 'user', text: 'what is on my board' },
        { id: '4', role: 'assistant', text: '**Two** cards:\n- [Voice nav](https://trello.com/c/x)\n- Widgets\n-# 💸 $0.01' },
      ],
    }), { status: 200 }));
    const reasoner = new PantheonMayaReasoner({ baseUrl: 'https://p.example/', botToken: 'tok', role: 'discord:42', fetchImpl: fetchImpl as any });
    const events = await collect(reasoner.stream({ userText: 'what is on my board' }));
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://p.example/api/chat');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ projectId: '__portfolio__', role: 'discord:42', message: 'what is on my board' });
    expect(events.filter((e) => e.type === 'token').map((e) => e.text).join('')).toBe('Two cards:\nVoice nav\nWidgets.');
    // The pipeline treats anything but 'stop' as a cut-off answer.
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' });
  });

  it('keeps the pipeline alive with heartbeats while Maya thinks', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({
      messages: [{ id: '1', role: 'user', text: 'hi' }, { id: '2', role: 'assistant', text: 'Hello.' }],
    }))), 30)));
    const reasoner = new PantheonMayaReasoner({ baseUrl: 'https://p.example', botToken: 't', role: 'r', heartbeatMs: 5, fetchImpl: fetchImpl as any });
    const events = await collect(reasoner.stream({ userText: 'hi' }));
    expect(events.some((e) => e.type === 'heartbeat')).toBe(true);
    expect(events.find((e) => e.type === 'token').text).toBe('Hello.');
  });

  it('says so out loud when Pantheon fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }));
    const reasoner = new PantheonMayaReasoner({ baseUrl: 'https://p.example', botToken: 't', role: 'r', fetchImpl: fetchImpl as any });
    const events = await collect(reasoner.stream({ userText: 'hi' }));
    expect(events.find((e) => e.type === 'token').text).toContain("couldn't reach Maya");
  });

  it('finds the reply after the latest copy of the message sent', () => {
    expect(replyAfter([
      { id: '1', role: 'user', text: 'hi' }, { id: '2', role: 'assistant', text: 'first' },
      { id: '3', role: 'user', text: 'hi' }, { id: '4', role: 'assistant', text: 'second' },
    ], 'hi')).toBe('second');
    expect(spokenText('## Plan\n1. Ship `it`\n```ts\nx\n```')).toBe('Plan\nShip it');
  });
});
