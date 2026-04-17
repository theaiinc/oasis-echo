import type { Turn } from '@oasis-echo/types';

export interface Summarizer {
  summarize(turns: Turn[], prior: string): Promise<string>;
}

/**
 * Trivial summarizer: keeps the most recent user/agent exchange.
 * Production swaps in the coordinator SLM with a compress prompt.
 */
export class LastTurnsSummarizer implements Summarizer {
  constructor(private readonly keep: number = 3) {}

  async summarize(turns: Turn[], prior: string): Promise<string> {
    const recent = turns.slice(-this.keep);
    const lines = recent.map((t) => {
      const u = t.userText.slice(0, 80);
      const a = (t.agentText ?? '').slice(0, 80);
      return `- user: "${u}" | agent: "${a}"`;
    });
    const carry = prior.length > 0 ? `${prior}\n` : '';
    return `${carry}${lines.join('\n')}`.slice(-1500);
  }
}
