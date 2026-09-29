import type { ServerResponse } from 'node:http';
import { alwaysEscalate, PassthroughTts, type StreamingTts } from '@oasis-echo/coordinator';
import { Pipeline } from '@oasis-echo/orchestrator';
import { ToolRegistry, ToolTalker, type Reasoner } from '@oasis-echo/reasoning';
import type { Logger } from '@oasis-echo/telemetry';
import { makeExpert, talkerFor, type AgentConfig, type EchoUser } from './agents.js';
import { ExpertDesk, LatencyEstimate, lateNote, type ExpertJob } from './experts.js';

/**
 * One live call per (user, agent), made on first use and dropped when idle.
 * The fast talker holds the conversation; a slow expert, if the agent has
 * one, is asked in the background and its answer spoken when it arrives.
 * Events go to the page in the same shape oasis-echo's SDK reads.
 */
export class Live {
  readonly pipeline: Pipeline;
  readonly clients = new Set<ServerResponse>();
  readonly desk: ExpertDesk | null;
  lastUsed = Date.now();
  private busy = 0;
  private readonly queue: string[] = [];

  constructor(
    readonly agent: AgentConfig,
    readonly user: EchoUser,
    deps: { env: NodeJS.ProcessEnv; tts: StreamingTts | null; latency: (agentId: string) => LatencyEstimate; logger?: Logger },
  ) {
    const { env, logger } = deps;
    const talker = talkerFor(agent, env);
    const expert = agent.expert ? makeExpert(agent.expert, user, env, logger) : null;
    this.desk = talker && expert && agent.expert
      ? new ExpertDesk(agent.expert.name, (q, signal) => expert.ask(q, signal), deps.latency(agent.id), {
          answered: (job) => void this.onAnswer(job, talker),
          late: (job, over) => this.say(lateNote(agent.expert!.name, over, job.updates)),
        })
      : null;

    let reasoner: Reasoner;
    if (talker) {
      const tools = new ToolRegistry();
      if (this.desk && agent.expert) {
        const desk = this.desk;
        tools.register<{ question?: string }, unknown>({
          name: `ask_${agent.expert.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
          description: `Ask ${agent.expert.name}${agent.expert.about ? ` (${agent.expert.about})` : ''} a question in the background. Returns at once with how long ${agent.expert.name} usually takes; the answer is spoken to the user when it arrives.`,
          input_schema: {
            type: 'object',
            properties: { question: { type: 'string', description: 'A complete, self-contained question, with any context from the call it needs.' } },
            required: ['question'],
          },
          handler: async ({ question }) => {
            if (!question?.trim()) return { error: 'question is required' };
            const { etaSeconds, alreadyAsked } = desk.start(question);
            return alreadyAsked
              ? { status: 'already_asked', eta_seconds: etaSeconds }
              : { status: 'asked', eta_seconds: etaSeconds, based_on: desk.estimate.samples ? `${desk.estimate.samples} recent answers` : 'a first guess' };
          },
        });
      }
      reasoner = new ToolTalker({
        apiKey: talker.apiKey,
        baseUrl: talker.baseUrl,
        model: talker.model,
        ...(talker.fallbackModel ? { fallbackModel: talker.fallbackModel } : {}),
        systemPrompt: talkerPrompt(agent, user, talker.persona),
        tools,
        context: () => this.desk?.contextNote(),
        ...(logger ? { logger } : {}),
      });
    } else if (expert) {
      reasoner = expert;
    } else {
      throw new Error(`agent ${agent.id}: no talker key and no expert`);
    }

    this.pipeline = new Pipeline({
      sessionId: `${agent.id}:${user.sub}`,
      router: alwaysEscalate,
      reasoner,
      tts: deps.tts ?? new PassthroughTts(),
      ...(logger ? { logger } : {}),
    });
    this.pipeline.bus.onAny((event) => this.send(event.type, wire(event as unknown as Record<string, unknown> & { type: string })));
  }

  /** Something the user said. A new turn interrupts whatever was playing. */
  async turn(text: string): Promise<void> {
    this.busy++;
    try {
      await this.pipeline.bargeIn();
      this.send('user.input', { text, atMs: Date.now() });
      await this.pipeline.handleTurn(text);
    } finally {
      this.busy--;
      void this.drain();
    }
  }

  send(type: string, payload: unknown): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  /** Say this when the line is free (after the current turn). */
  say(text: string): void {
    this.queue.push(text);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.busy === 0 && this.queue.length) {
      const text = this.queue.shift()!;
      this.busy++;
      try {
        await this.pipeline.announce(text);
      } finally {
        this.busy--;
      }
    }
  }

  private async onAnswer(job: ExpertJob, talker: { apiKey: string; baseUrl: string; model: string; fallbackModel?: string }): Promise<void> {
    const name = this.agent.expert?.name ?? 'The expert';
    this.send('expert.answer', { id: job.id, expert: name, question: job.question, status: job.status, answer: job.answer ?? null, error: job.error ?? null, atMs: Date.now() });
    if (job.status !== 'done' || !job.answer) {
      this.say(`Sorry, I couldn't get an answer from ${name} on that. Want me to try again?`);
      return;
    }
    // Summaries go to the dependable model when there are two.
    const summarizer = { ...talker, model: talker.fallbackModel ?? talker.model };
    this.say(await spoken(job.question, job.answer, name, summarizer).catch(() => `${name} says: ${job.answer!.slice(0, 600)}`));
  }
}

/** The expert's answer, as a few sentences worth saying out loud. */
async function spoken(question: string, answer: string, expert: string, talker: { apiKey: string; baseUrl: string; model: string }): Promise<string> {
  const res = await fetch(`${talker.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${talker.apiKey}` },
    body: JSON.stringify({
      model: talker.model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: `You are speaking on a live voice call. ${expert} just answered a question the user asked a moment ago. Tell the user what ${expert} said in at most four short spoken sentences: lead with "${expert} says" or similar, keep names and numbers exact, no markdown, no lists, no links. Offer the details if there is more.` },
        { role: 'user', content: `Question: ${question}\n\n${expert}'s answer:\n${answer}` },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`summary ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('empty summary');
  return text;
}

function talkerPrompt(agent: AgentConfig, user: EchoUser, persona?: string): string {
  const expert = agent.expert;
  return [
    persona ?? `You are ${agent.name}'s voice on a live call with ${user.email} (${agent.project}).`,
    'This is speech: answer in one to three short, natural sentences. No markdown, lists, or links. Answer first; ask back only when you truly need to.',
    'Answer yourself whatever you can: conversation, general knowledge, planning, helping the user think.',
    ...(expert ? [
      `${expert.name} is ${expert.about ?? `the ${agent.project} assistant who knows this user's projects and work`}. Only ${expert.name} knows their projects, boards, decisions and status: never guess those.`,
      `When a question needs ${expert.name}, call ask_${expert.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')} with a complete, self-contained question. It returns at once with how long ${expert.name} usually takes.`,
      `Then say you've asked ${expert.name} and roughly how long it takes (round it: "about a minute"), and keep the call useful while waiting: say what you're checking, ask one thing that would sharpen the answer, or offer something quick you can answer yourself. Do not repeat the wait time every turn.`,
      `${expert.name}'s answer is spoken to the user automatically when it arrives. If asked whether it's ready, use the background notes.`,
    ] : []),
  ].join('\n');
}

/** A pipeline event as the SDK reads it: tts.chunk carries base64 PCM as `audio`. */
export function wire(event: Record<string, unknown> & { type: string }): unknown {
  if (event.type === 'tts.chunk') {
    const pcm = event['pcm'] as Int16Array | undefined;
    return {
      turnId: event['turnId'],
      text: event['text'],
      sampleRate: event['sampleRate'],
      final: event['final'],
      filler: event['filler'] === true,
      atMs: event['atMs'],
      ...(pcm && pcm.length ? { audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') } : {}),
    };
  }
  if (event.type === 'error') return { source: event['source'], error: String((event['error'] as Error)?.message ?? event['error']), atMs: event['atMs'] };
  return event;
}

export class Sessions {
  private readonly live = new Map<string, Live>();
  private readonly latencies = new Map<string, LatencyEstimate>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: { env: NodeJS.ProcessEnv; tts: StreamingTts | null; logger?: Logger },
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
      live = new Live(agent, user, {
        ...this.deps,
        latency: (id) => {
          let est = this.latencies.get(id);
          if (!est) this.latencies.set(id, (est = new LatencyEstimate((agent.expert?.typicalSeconds ?? 60) * 1000)));
          return est;
        },
      });
      this.live.set(key, live);
    }
    live.lastUsed = Date.now();
    return live;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, live] of this.live) {
      if (live.clients.size === 0 && !live.desk?.running().length && now - live.lastUsed > this.idleMs) this.live.delete(key);
    }
  }
}
