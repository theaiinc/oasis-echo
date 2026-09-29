import type { Logger } from '@oasis-echo/telemetry';
import type { Reasoner, ReasoningStreamEvent } from './anthropic-client.js';

/**
 * Maya, the portfolio assistant in Pantheon (pantheon-board), as the voice
 * agent's brain. A spoken turn goes to the same chat API Pantheon's Discord
 * and Zalo relays use (`POST /api/chat` with the bot service token), under
 * one `role` — use the Discord one (`discord:<userId>`) to continue the same
 * conversation you have with Maya in Discord.
 *
 * Maya answers in one piece (she may consult Simasis first, which takes
 * seconds), so this waits for her reply, sends heartbeats meanwhile, and
 * hands the whole answer to TTS as plain spoken text.
 */
export type PantheonMayaReasonerOptions = {
  /** e.g. https://pantheon.theaiinc.com */
  baseUrl: string;
  /** pantheon-board's bot service token (PANTHEON_BOT_SERVICE_TOKEN there). */
  botToken: string;
  /** The conversation to talk in, e.g. `discord:767623901740007446` or `voice:steve`. */
  role: string;
  timeoutMs?: number;
  heartbeatMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
};

/** Maya's portfolio thread (pantheon-board MAYA_PROJECT_ID). */
const MAYA_PROJECT_ID = '__portfolio__';

type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; error?: boolean };

export class PantheonMayaReasoner implements Reasoner {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PantheonMayaReasonerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 330_000;
    this.heartbeatMs = opts.heartbeatMs ?? 2_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *stream(input: { userText: string; signal?: AbortSignal }): AsyncIterable<ReasoningStreamEvent> {
    const started = Date.now();
    const reply = this.ask(input.userText, input.signal);
    // Keep the pipeline informed while Maya thinks.
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<'tick'>((resolve) => { timer = setTimeout(() => resolve('tick'), this.heartbeatMs); });
      const first = await Promise.race([reply.then(() => 'done' as const, () => 'done' as const), tick]);
      clearTimeout(timer);
      if (first === 'done') break;
      yield { type: 'heartbeat', atMs: Date.now() - started };
    }
    let text: string;
    try {
      text = spokenText(await reply);
    } catch (err) {
      if (input.signal?.aborted) return;
      this.opts.logger?.warn('pantheon maya failed', { error: err instanceof Error ? err.message : String(err) });
      text = "Sorry, I couldn't reach Maya just now. Try again in a moment.";
    }
    text = text || "Maya didn't say anything back.";
    // The pipeline hears an answer without a closing mark as cut off; a
    // chat reply often ends on a list item.
    if (!/[.!?]["')\]]?$/.test(text)) text += '.';
    yield { type: 'token', text };
    yield { type: 'done', stopReason: 'stop', inputTokens: 0, outputTokens: 0 };
  }

  /** Maya's reply to this message: what she added to the thread after it. */
  private async ask(message: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.botToken}` },
      body: JSON.stringify({ projectId: MAYA_PROJECT_ID, role: this.opts.role, message }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`Pantheon /api/chat answered ${res.status}`);
    const { messages } = (await res.json()) as { messages?: ChatMessage[] };
    return replyAfter(messages ?? [], message);
  }
}

/** The assistant messages after the last user message with this text. */
export function replyAfter(messages: ChatMessage[], sent: string): string {
  let mine = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user' && messages[i]!.text.trim() === sent.trim()) { mine = i; break; }
  }
  return messages.slice(mine + 1).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n\n');
}

/** Chat markdown as something worth saying out loud. */
export function spokenText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^-#.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
