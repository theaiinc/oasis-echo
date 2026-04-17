import type { DialogueState } from '@oasis-echo/types';
import type { Reasoner, ReasoningStreamEvent } from './anthropic-client.js';

/**
 * Deterministic reasoner used in tests and when no API key is set.
 * Produces a short streaming reply so the orchestrator spine stays
 * exercised without network calls.
 */
export class MockReasoner implements Reasoner {
  constructor(private readonly opts: { tokens?: string[]; delayMs?: number } = {}) {}

  async *stream(input: {
    userText: string;
    state: DialogueState;
    signal?: AbortSignal;
  }): AsyncIterable<ReasoningStreamEvent> {
    void input.state;
    const tokens =
      this.opts.tokens ??
      defaultReply(input.userText)
        .split(/(\s+)/)
        .filter((t) => t.length > 0);
    const delay = this.opts.delayMs ?? 5;
    let out = 0;
    for (const token of tokens) {
      if (input.signal?.aborted) return;
      await sleep(delay);
      yield { type: 'token', text: token };
      out += Math.max(1, Math.round(token.length / 4));
    }
    yield { type: 'done', stopReason: 'end_turn', inputTokens: 0, outputTokens: out };
  }
}

function defaultReply(userText: string): string {
  const t = userText.toLowerCase();
  if (t.includes('time')) return 'It is currently a moment in time you can verify on your clock.';
  if (t.includes('weather')) return 'I would need a tool to check the weather right now.';
  if (t.startsWith('why')) return 'Because the underlying cause is more complex than it appears.';
  if (t.startsWith('how')) return 'The process has several steps, but the core idea is straightforward.';
  return 'Here is a short, cloud-quality response to your request.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
