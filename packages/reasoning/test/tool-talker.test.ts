import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../src/tools.js';
import { ToolTalker } from '../src/tool-talker.js';

const state = { sessionId: 's', phase: 'idle', allowedIntents: [], slots: {}, turns: [{ id: '1', startedAtMs: 0, userText: 'hi', agentText: 'Hello!', tier: 'local', interrupted: false }], summary: '', startedAtMs: 0, lastActivityMs: 0 } as any;
const sse = (chunks: object[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

async function collect(it: AsyncIterable<any>) { const out: any[] = []; for await (const e of it) out.push(e); return out; }

describe('ToolTalker', () => {
  it('calls a tool, feeds the result back, and keeps talking', async () => {
    const tools = new ToolRegistry();
    const handler = vi.fn(async () => ({ status: 'asked', eta_seconds: 60 }));
    tools.register({ name: 'ask_maya', description: 'd', input_schema: { type: 'object', properties: { question: { type: 'string' } } }, handler });
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ask_maya', arguments: '{"question":"What ' } }] } }] },
               { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'is late?"}' } }] }, finish_reason: 'tool_calls' }] }])
        : sse([{ choices: [{ delta: { content: "I've asked Maya; about a minute." }, finish_reason: 'stop' }] }]);
    });
    const talker = new ToolTalker({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', systemPrompt: 'be brief', tools, context: () => 'Maya is idle.', fetchImpl: fetchImpl as any });
    const events = await collect(talker.stream({ userText: 'what is late?', state }));
    expect(handler).toHaveBeenCalledWith({ question: 'What is late?' });
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'tool_result', 'token', 'done']);
    expect(events.at(-1)).toMatchObject({ stopReason: 'stop' });
    expect(bodies[0].messages.map((m: any) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'user']);
    expect(bodies[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"status":"asked","eta_seconds":60}' });
  });

  it('just talks when no tool is needed, and offers no tools when told not to', async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return sse([{ choices: [{ delta: { content: 'Sure.' }, finish_reason: 'stop' }] }]); });
    const tools = new ToolRegistry();
    tools.register({ name: 't', description: 'd', input_schema: { type: 'object' }, handler: async () => ({}) });
    const talker = new ToolTalker({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', systemPrompt: 's', tools, fetchImpl: fetchImpl as any });
    const events = await collect(talker.stream({ userText: 'hey', state, allowTools: false }));
    expect(events.map((e) => e.type)).toEqual(['token', 'done']);
    expect(bodies[0].tools).toBeUndefined();
  });
});
