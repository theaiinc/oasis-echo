import type { ServerResponse } from 'node:http';
import { alwaysEscalate, PassthroughTts } from '@oasis-echo/coordinator';
import { Pipeline } from '@oasis-echo/orchestrator';
import type { Reasoner } from '@oasis-echo/reasoning';
import type { Logger } from '@oasis-echo/telemetry';
import type { AgentConfig, EchoUser } from './agents.js';

/**
 * One voice pipeline per (user, agent), made on first use and dropped when
 * idle. The browser does speech recognition and speech (Web Speech), so a
 * pipeline is only dialogue state and the agent's brain: cheap to keep.
 * Every request goes to the agent (no local router model in the cloud).
 */
type Live = {
  pipeline: Pipeline;
  clients: Set<ServerResponse>;
  lastUsed: number;
};

export type MakeReasoner = (agent: AgentConfig, user: EchoUser) => Reasoner;

export class Sessions {
  private readonly live = new Map<string, Live>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly makeReasoner: MakeReasoner,
    private readonly logger?: Logger,
    private readonly idleMs = 30 * 60_000,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  get size(): number {
    return this.live.size;
  }

  get(agent: AgentConfig, user: EchoUser): Live {
    const key = `${user.sub}\u0000${agent.id}`;
    let live = this.live.get(key);
    if (!live) {
      const pipeline = new Pipeline({
        sessionId: `${agent.id}:${user.sub}`,
        router: alwaysEscalate,
        reasoner: this.makeReasoner(agent, user),
        tts: new PassthroughTts(),
        ...(this.logger ? { logger: this.logger } : {}),
      });
      const created: Live = { pipeline, clients: new Set(), lastUsed: Date.now() };
      pipeline.bus.onAny((event) => {
        const out = relay(event as unknown as Record<string, unknown> & { type: string });
        if (!out) return;
        const frame = `event: ${out.type}\ndata: ${JSON.stringify(out.data)}\n\n`;
        for (const res of created.clients) res.write(frame);
      });
      this.live.set(key, created);
      live = created;
    }
    live.lastUsed = Date.now();
    return live;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, live] of this.live) {
      if (live.clients.size === 0 && now - live.lastUsed > this.idleMs) this.live.delete(key);
    }
  }
}

/** What the page needs from the pipeline's events (text only; no audio server-side). */
export function relay(event: Record<string, unknown> & { type: string }): { type: string; data: unknown } | null {
  switch (event.type) {
    case 'tts.chunk':
      return { type: 'say', data: { turnId: event['turnId'], text: event['text'], final: event['final'], filler: event['filler'] === true } };
    case 'tts.done':
      return { type: 'said', data: { turnId: event['turnId'] } };
    case 'turn.complete': {
      const turn = event['turn'] as { id: string; userText: string; agentText: string; interrupted: boolean };
      return { type: 'turn', data: { id: turn.id, userText: turn.userText, agentText: turn.agentText, interrupted: turn.interrupted } };
    }
    case 'bargein':
      return { type: 'stop', data: {} };
    default:
      return null;
  }
}
