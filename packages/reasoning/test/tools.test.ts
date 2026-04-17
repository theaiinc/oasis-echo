import { describe, expect, it } from 'vitest';
import { ToolRegistry, echoTool, timeTool } from '../src/tools.js';

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const r = new ToolRegistry();
    r.register(timeTool());
    r.register(echoTool());
    expect(r.get('get_current_time')?.name).toBe('get_current_time');
    expect(r.list()).toHaveLength(2);
  });

  it('rejects duplicate registration', () => {
    const r = new ToolRegistry();
    r.register(echoTool());
    expect(() => r.register(echoTool())).toThrow();
  });

  it('exposes anthropic-shaped tool defs without handlers', () => {
    const r = new ToolRegistry();
    r.register(echoTool());
    const anth = r.toAnthropicTools();
    expect(anth[0]).not.toHaveProperty('handler');
    expect(anth[0]).toHaveProperty('input_schema');
  });

  it('invokes handlers', async () => {
    const r = new ToolRegistry();
    r.register(echoTool());
    const t = r.get('echo')!;
    const out = (await t.handler({ text: 'hi' })) as { text: string };
    expect(out.text).toBe('hi');
  });
});
