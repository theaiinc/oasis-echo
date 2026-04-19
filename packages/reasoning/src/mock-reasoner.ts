import type { DialogueState } from '@oasis-echo/types';
import type { Reasoner, ReasoningStreamEvent } from './anthropic-client.js';

/**
 * Deterministic reasoner used in tests and when no API key is set.
 * Produces a short streaming reply so the orchestrator spine stays
 * exercised without network calls.
 *
 * The replies are intentionally shallow — they echo context from the
 * dialogue state so the mock feels a bit more alive, but there is no
 * real reasoning here. Set ANTHROPIC_API_KEY to route through Claude.
 */
export class MockReasoner implements Reasoner {
  constructor(private readonly opts: { tokens?: string[]; delayMs?: number } = {}) {}

  async *stream(input: {
    userText: string;
    state: DialogueState;
    signal?: AbortSignal;
  }): AsyncIterable<ReasoningStreamEvent> {
    const tokens =
      this.opts.tokens ??
      defaultReply(input.userText, input.state)
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

function defaultReply(userText: string, state: DialogueState): string {
  const t = userText.toLowerCase();
  const recentUser = state.turns
    .slice(-3)
    .map((turn) => turn.userText)
    .filter((x) => x && x.length > 0);
  const memoryBlurb =
    recentUser.length > 0
      ? `Earlier you mentioned: ${recentUser.join('; ')}.`
      : `This is our first exchange.`;

  if (/\b(remember|recall|what did (i|we)|what have we)\b/.test(t)) {
    return recentUser.length > 0
      ? `So far you have said: ${recentUser.join('; ')}. I am a local mock without real reasoning — set ANTHROPIC_API_KEY for a smarter agent.`
      : `We have not talked about anything yet. Without ANTHROPIC_API_KEY I cannot reason beyond this turn.`;
  }
  if (t.includes('time')) return 'It is currently a moment in time you can verify on your clock.';
  if (t.includes('weather')) return 'I would need a weather tool to answer that for real.';
  if (t.includes('name') && t.includes('your'))
    return 'I am a mock reasoner. The real agent ships once you add ANTHROPIC_API_KEY.';
  if (t.startsWith('why')) return `Because the cause runs deeper than a mock can reach. ${memoryBlurb}`;
  if (t.startsWith('how'))
    return `The process has several steps but is conceptually simple. ${memoryBlurb}`;
  if (t.startsWith('what')) return `A short mock answer about that. ${memoryBlurb}`;
  return `I am the mock reasoner — responses are shallow. ${memoryBlurb} Add an ANTHROPIC_API_KEY to switch on real reasoning.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
