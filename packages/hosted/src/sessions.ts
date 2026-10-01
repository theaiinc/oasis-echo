import type { ServerResponse } from 'node:http';
import { alwaysEscalate, PassthroughTts, type StreamingTts } from '@oasis-echo/coordinator';
import { Pipeline } from '@oasis-echo/orchestrator';
import { ToolRegistry, ToolTalker, type Reasoner } from '@oasis-echo/reasoning';
import type { Logger } from '@oasis-echo/telemetry';
import { displayName, makeExpert, talkerFor, type AgentConfig, type EchoUser } from './agents.js';
import { ExpertDesk, LatencyEstimate, lateNote, progressNote, type ExpertJob } from './experts.js';
import { HearingFixes, KeptFacts, WorkingNotes, userKey, type FactStore } from './memory.js';
import { isVietnamese } from './vieneu.js';
import { SharedVoice } from './voice.js';

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
  readonly expert: { ask(q: string, signal?: AbortSignal): Promise<string> } | null;
  /** Who the user is and what they're working on, looked up once in the background (see Sessions). */
  profile: (() => string | undefined) | null = null;
  /** Words the listener got wrong this call and what the user meant, fixed in every later transcript. */
  readonly hearing = new HearingFixes();
  /** Short-lived notes for the talker (e.g. a reply the user cut off); they fade when unused. */
  readonly notes = new WorkingNotes();
  /** What this user explicitly asked to be remembered, kept across calls. */
  readonly facts: KeptFacts;
  /** The reply language, pinned: set by the user's explicit request, else the language of their first words. */
  private language: string | null = null;
  private firstWords: string | null = null;
  /** The page's language setting (e.g. "vi-VN"), before the user has said anything. */
  pageLanguage: string | null = null;
  /** When the line last went quiet (a turn or announcement ended). */
  private quietSince = Date.now();

  constructor(
    readonly agent: AgentConfig,
    readonly user: EchoUser,
    deps: { env: NodeJS.ProcessEnv; tts: StreamingTts | null; latency: (agentId: string) => LatencyEstimate; logger?: Logger; facts?: FactStore | null },
  ) {
    const { env, logger } = deps;
    this.facts = new KeptFacts(deps.facts ?? null, userKey(user.sub), logger);
    const talker = talkerFor(agent, env);
    const expert = agent.expert ? makeExpert(agent.expert, user, env, logger) : null;
    this.expert = expert;
    this.desk = talker && expert && agent.expert
      ? new ExpertDesk(expertIsSelf(agent) ? 'Your background lookup' : agent.expert.name, (q, signal) => expert.ask(q, signal), deps.latency(agent.id), {
          answered: (job) => void this.onAnswer(job, talker),
          late: (job, over) => this.say(lateNote(over, job.updates, this.callLanguage())),
          progress: (_job, n) => this.sayIfQuiet(progressNote(n, this.callLanguage())),
        })
      : null;

    let reasoner: Reasoner;
    if (talker) {
      const tools = new ToolRegistry();
      if (this.desk && agent.expert) {
        const desk = this.desk;
        tools.register<{ question?: string }, unknown>({
          name: `ask_${agent.expert.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
          description: expertIsSelf(agent)
            ? `Look something up in the background${agent.expert.about ? ` (${agent.expert.about})` : ''}. Returns at once with how long it usually takes; the answer is spoken to the user when it arrives.`
            : `Ask ${agent.expert.name}${agent.expert.about ? ` (${agent.expert.about})` : ''} a question in the background. Returns at once with how long ${agent.expert.name} usually takes; the answer is spoken to the user when it arrives.`,
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
      tools.register<{ heard?: string; meant?: string }, unknown>({
        name: 'note_correction',
        description: 'The user corrected a word you misheard ("no, I said Arion", "it\'s Bookkeeper, not book keeper"). Record it so later transcripts get it right. Use the exact misheard words from their earlier message.',
        input_schema: {
          type: 'object',
          properties: {
            heard: { type: 'string', description: 'What the transcript said (misheard).' },
            meant: { type: 'string', description: 'What the user actually said.' },
          },
          required: ['heard', 'meant'],
        },
        handler: async ({ heard, meant }) => (heard?.trim() && meant?.trim() ? { ok: this.hearing.add(heard, meant) } : { error: 'heard and meant are required' }),
      });
      tools.register<{ fact?: string }, unknown>({
        name: 'remember',
        description: 'Save a fact the user asked you to remember (in any language: "remember", "keep in mind", "nhớ giúp tôi", "don\'t make me repeat"). Kept across calls. Required whenever the user asks you to remember something; only then.',
        input_schema: {
          type: 'object',
          properties: { fact: { type: 'string', description: 'The fact, written as a short standalone statement about the user.' } },
          required: ['fact'],
        },
        handler: async ({ fact }) => (fact?.trim() ? this.facts.remember(fact) : { error: 'fact is required' }),
      });
      tools.register<{ about?: string }, unknown>({
        name: 'forget',
        description: 'Drop kept facts. Only when the user explicitly asks you to forget something; "everything" drops all of them.',
        input_schema: {
          type: 'object',
          properties: { about: { type: 'string', description: 'Words from the fact to drop, or "everything".' } },
          required: ['about'],
        },
        handler: async ({ about }) => (about?.trim() ? this.facts.forget(about) : { error: 'about is required' }),
      });
      tools.register<{ language?: string }, unknown>({
        name: 'set_language',
        description: 'Change the language you reply in. Only when the user explicitly asks you to reply or speak in another language.',
        input_schema: {
          type: 'object',
          properties: { language: { type: 'string', description: 'The language the user asked for, in English (e.g. "tiếng Nhật" → "Japanese", "back to English" → "English").' } },
          required: ['language'],
        },
        handler: async ({ language }) => {
          if (!language?.trim()) return { error: 'language is required' };
          this.language = language.trim();
          return { ok: true, language: this.language, note: `Reply in ${this.language} from now on, starting with this reply.` };
        },
      });
      reasoner = new ToolTalker({
        apiKey: talker.apiKey,
        baseUrl: talker.baseUrl,
        model: talker.model,
        ...(talker.fallbackModel ? { fallbackModel: talker.fallbackModel } : {}),
        systemPrompt: talkerPrompt(agent, user, talker.persona),
        tools,
        context: () => this.context(),
        turnNote: () => this.languageNote(),
        temperature: 0.8,
        // What matters comes from the notes above; a few turns are enough for the flow of talk.
        historyTurns: 3,
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
      tts: deps.tts ? (deps.tts instanceof SharedVoice ? deps.tts.forCall(() => this.callLanguage()) : deps.tts) : new PassthroughTts(),
      // A voice call: no "sorry, go ahead" before answering an interruption, and keep
      // what was cut off so a follow-up can pick it up instead of starting over.
      apologizeAfterInterruption: false,
      keepInterruptedReply: true,
      fillerLanguage: () => this.callLanguage(),
      maxFillersPerTurn: 3,
      // A filler only when the answer is actually slow (a lookup); a normal answer starts
      // in ~1.1 s, and a filler before every one of them sounds canned.
      fillerDelayMs: 900,
      ...(logger ? { logger } : {}),
    });
    this.pipeline.bus.on('turn.complete', ({ turn }) => {
      const said = turn.agentText ?? '';
      if (turn.interrupted && said.includes('[not yet said:')) {
        this.notes.put('interrupted', `Your last reply was cut off by the user: ${said.slice(0, 800)} If they come back to it, answer from this instead of starting over.`);
      }
    });
    // One line per turn with how long each stage took, so a slow reply shows where the time went.
    const timings = new Map<string, string[]>();
    this.pipeline.bus.onAny((event) => {
      this.send(event.type, wire(event as unknown as Record<string, unknown> & { type: string }));
      if (event.type !== 'turn.timeline') return;
      const { turnId, stage, elapsedMs, detail } = event as unknown as { turnId: string; stage: string; elapsedMs: number; detail?: string };
      const stages = timings.get(turnId) ?? [];
      stages.push(`${stage}${detail ? `(${detail})` : ''}@${elapsedMs}`);
      timings.set(turnId, stages);
      if (stage === 'tts.done') {
        timings.delete(turnId);
        logger?.info('turn timing', { agent: agent.id, turnId, stages: stages.join(' ') });
      }
    });
  }

  /** Something the user said. A new turn interrupts whatever was playing. */
  async turn(raw: string): Promise<void> {
    this.busy++;
    try {
      await this.pipeline.bargeIn();
      const text = this.hearing.apply(raw);
      this.send('user.input', { text, atMs: Date.now() });
      this.firstWords ??= text.slice(0, 200);
      await this.pipeline.handleTurn(text);
    } finally {
      this.busy--;
      this.quietSince = Date.now();
      void this.drain();
    }
  }

  send(type: string, payload: unknown): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  /**
   * The call's language as far as speech is concerned (fillers, backchannels, which
   * listener): the user's explicit choice, else the page's setting, else their first words.
   */
  callLanguage(): 'en' | 'vi' {
    if (this.language) return /viet|việt/i.test(this.language) ? 'vi' : 'en';
    if (this.pageLanguage) return this.pageLanguage.toLowerCase().startsWith('vi') ? 'vi' : 'en';
    return this.firstWords && isVietnamese(this.firstWords) ? 'vi' : 'en';
  }

  /** The reply-language pin, sent right after the user's words each turn. */
  private languageNote(): string | undefined {
    const current = this.language ?? (this.firstWords ? `the language of the user's first words in this call ("${this.firstWords}")` : null);
    // (Page setting only picks the listener and fillers; the reply follows what the user actually says.)
    if (!current) return undefined;
    return `If this message asks you to reply in a different language, call set_language with the language they name, then reply in it. Otherwise reply in ${current}, whatever language this message is in.`;
  }

  /** What the talker is told each turn in place of a long history: kept facts, fresh notes, background work. */
  private context(): string | undefined {
    const parts: string[] = [];
    const facts = this.facts.list();
    if (facts.length) parts.push(`What the user asked you to remember:\n${facts.map((f) => `- ${f}`).join('\n')}`);
    const profile = this.profile?.();
    if (profile) parts.push(`About ${displayName(this.user)} (from your background knowledge): ${profile}`);
    const fixes = this.hearing.list();
    if (fixes.length) parts.push(`Misheard earlier in this call (already fixed in what you see): ${fixes.join('; ')}`);
    const notes = this.notes.read();
    if (notes.length) parts.push(`Notes from this call:\n${notes.map((n) => `- ${n}`).join('\n')}`);
    const desk = this.desk?.contextNote();
    if (desk) parts.push(desk);
    return parts.length ? parts.join('\n\n') : undefined;
  }

  /** Utterances the server started a turn for itself, by speculation id (so the page's copy is skipped). */
  private readonly claimed: string[] = [];

  claimUtterance(id: string | null): void {
    if (!id) return;
    this.claimed.push(id);
    while (this.claimed.length > 20) this.claimed.shift();
  }

  alreadyClaimed(id: string | null): boolean {
    return !!id && this.claimed.includes(id);
  }

  /** Answer the call: a short hello in the call's language, so the line isn't silent. */
  greet(): void {
    this.say(greeting(this.agent.name, this.callLanguage()));
  }

  /** Say this only if nothing is playing or queued and it has been quiet for a moment; otherwise skip it. */
  sayIfQuiet(text: string, quietMs = 6_000): void {
    if (this.busy > 0 || this.queue.length || Date.now() - this.quietSince < quietMs) return;
    this.say(text);
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
        this.quietSince = Date.now();
      }
    }
  }

  private async onAnswer(job: ExpertJob, talker: { apiKey: string; baseUrl: string; model: string; fallbackModel?: string }): Promise<void> {
    const name = this.agent.expert?.name ?? 'The expert';
    const self = expertIsSelf(this.agent);
    const lang = this.callLanguage();
    this.send('expert.answer', { id: job.id, expert: name, question: job.question, status: job.status, answer: job.answer ?? null, error: job.error ?? null, atMs: Date.now() });
    if (job.status !== 'done' || !job.answer) {
      this.say(lang === 'vi'
        ? 'Xin lỗi, mình chưa tra được câu đó. Bạn muốn mình thử lại không?'
        : self ? "Sorry, I couldn't find that one. Want me to try again?" : `Sorry, I couldn't get an answer from ${name} on that. Want me to try again?`);
      return;
    }
    // Summaries go to the dependable model when there are two.
    const summarizer = { ...talker, model: talker.fallbackModel ?? talker.model };
    const fallback = self ? `Here's what I found: ${job.answer.slice(0, 600)}` : `${name} says: ${job.answer.slice(0, 600)}`;
    // What the user already heard this call, so a repeat lookup reports only what's new.
    const already = this.notes.read().filter((n) => n.startsWith(TOLD));
    const said = await spoken(job.question, job.answer, self ? null : name, lang, summarizer, already.map((n) => n.slice(TOLD.length))).catch(() => fallback);
    job.delivered = true;
    this.notes.put(`told-${job.id}`, `${TOLD}${said}`);
    this.say(said);
  }
}

/**
 * Whether the background expert is the agent itself (the same name, e.g. Maya on the
 * phone and Maya's deep lookup). Then the talker speaks of it in the first person
 * ("let me look into that"), never "I've asked Maya".
 */
export function expertIsSelf(agent: AgentConfig): boolean {
  return !!agent.expert && agent.expert.name.trim().toLowerCase() === agent.name.trim().toLowerCase();
}

/** Working-note prefix for lookup answers already spoken to the user (they fade like other notes). */
const TOLD = 'Already told the user (don\'t repeat unless they ask): ';

/** What the agent says when a call picks up. */
export function greeting(name: string, lang: 'en' | 'vi'): string {
  return lang === 'vi' ? `Chào bạn, mình là ${name}. Mình giúp gì được cho bạn?` : `Hi, this is ${name}. How can I help?`;
}

/** The expert's answer, as a few sentences worth saying out loud. */
async function spoken(question: string, answer: string, expert: string | null, lang: 'en' | 'vi', talker: { apiKey: string; baseUrl: string; model: string }, already: string[] = []): Promise<string> {
  // expert null: the agent looked it up itself, so it reports in the first person.
  const who = expert
    ? `${expert} just answered a question the user asked a moment ago. Tell the user what ${expert} said in at most four short spoken sentences: lead with "${expert} says" or similar,`
    : `You just finished looking into a question the user asked a moment ago. Tell the user what you found, in the first person, in at most four short spoken sentences: lead with "Okay, here's what I found" or similar, never refer to yourself by name or as someone else,`;
  const language = lang === 'vi' ? ' Speak Vietnamese.' : '';
  // Each lookup returns the full picture (e.g. the whole board list); say only what the user hasn't heard.
  const earlier = already.length
    ? ` Earlier in this call the user was already told:\n${already.map((a) => `- ${a}`).join('\n')}\nDon't repeat any of that. Say only what is new or answers this exact question; if nothing is new, say so in one short sentence. If this contradicts something they were told, say so plainly ("Actually, correction: …").`
    : '';
  const res = await fetch(`${talker.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${talker.apiKey}` },
    body: JSON.stringify({
      model: talker.model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: `You are speaking on a live voice call. ${who} keep names and numbers exact, no markdown, no lists, no links, address the user as "you" (never by name). Offer the details if there is more.${earlier}${language}` },
        { role: 'user', content: `Question: ${question}\n\nAnswer found:\n${answer}` },
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
    persona ?? `You are ${agent.name}, on a live call with ${displayName(user)} (${user.email}), about ${agent.project}. Speak as yourself, in the first person.`,
    `Who's who: in their messages, "I", "me", "my" mean ${displayName(user)}; "you" means you, ${agent.name}. Anyone else they name, or "he", "she", "they", is another person: keep track of who's who and don't mix them up with the user. The notes say what's known about them.`,
    'This is speech: answer in one to three short, natural sentences. No markdown, lists, or links. Answer first; ask back only when you truly need to.',
    'Sound like a person, not a script: vary how you start and end, react to what they actually said, and keep follow-ups short ("yep", "got it, one sec"). Don\'t end every reply with a question, don\'t open with the same words twice in a row, and never repeat a sentence or offer you already made in this call.',
    'Answer yourself whatever you can: conversation, general knowledge, planning, helping the user think.',
    'Language: each user message ends with a bracketed note naming the reply language. Follow it for every reply, even when the message itself is in another language. Only when the user explicitly asks to switch, call set_language, then reply in the new language. Never mention the note.',
    'Hearing: the user\'s words come from speech recognition and can be misheard (a project name, a technical term, a word that sounds alike). Read them by what makes sense in context, especially names from their projects and the notes; only if it\'s genuinely unclear, check briefly ("Arion, you mean?"). When they explicitly correct a word you misheard ("no, I said…"), take it without fuss, call note_correction once for that word, and answer what they meant. Don\'t call it otherwise.',
    'Self-correction: if the notes, a lookup, or the user show something you said earlier was wrong, say so plainly and give the right version ("Actually, I had that wrong: …"). Don\'t defend or repeat a mistake.',
    'Address the user as "you", never by their name or email.',
    'Memory: you get only the last few turns, plus notes. Rely on the notes. Notes marked "already told the user" are things they have heard this call: don\'t repeat them unless asked; build on them, and look something up again only for a new or more specific question.',
    'When the user asks you to remember something, keep it in mind, or not make them repeat it (in any language, e.g. "nhớ giúp tôi", "remember that"), you must call remember with that fact before you reply; never say you will remember without calling it. Call forget when they ask you to forget. Never store anything they did not ask you to keep.',
    ...(expert && expertIsSelf(agent) ? [
      `You are ${expert.about ?? `the ${agent.project} assistant who knows this user's projects and work`}. Their projects, boards, decisions and status come only from your background lookup: never guess those.`,
      `When a question needs that, call ask_${expert.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')} with a complete, self-contained question written in the user's own voice, as they would ask it ("What needs my attention today?"), never "the user". It returns at once with how long it usually takes.`,
      `Then say briefly, in the first person, that you're on it. Mention roughly how long it takes only the first time ("give me about a minute"). Don't fill the wait with the same follow-up question each time; only ask something if it would genuinely sharpen the answer, otherwise just carry on the conversation. Never talk about ${agent.name} as someone else.`,
      `The answer is spoken to the user automatically when it arrives. If asked whether it's ready, check the background notes and answer in a few words without calling the lookup again.`,
    ] : expert ? [
      `${expert.name} is ${expert.about ?? `the ${agent.project} assistant who knows this user's projects and work`}. Only ${expert.name} knows their projects, boards, decisions and status: never guess those.`,
      `When a question needs ${expert.name}, call ask_${expert.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')} with a complete, self-contained question written in the user's own voice ("What needs my attention today?"), never "the user". It returns at once with how long ${expert.name} usually takes.`,
      `Then say briefly that you've asked ${expert.name}, and roughly how long it takes only the first time ("about a minute"). Don't fill the wait with the same follow-up question each time; only ask something if it would genuinely sharpen the answer.`,
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
    private readonly deps: { env: NodeJS.ProcessEnv; tts: StreamingTts | null; logger?: Logger; facts?: FactStore | null },
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
      const userKey = `${user.sub}\u0000${agent.id}`;
      live.profile = () => this.profiles.get(userKey)?.text;
      this.refreshProfile(userKey, live);
    }
    live.lastUsed = Date.now();
    return live;
  }

  /** Per user and agent: a short "who they are and what they're working on", refreshed every 12 h. */
  private readonly profiles = new Map<string, { text?: string; at: number }>();

  private refreshProfile(key: string, live: Live): void {
    const have = this.profiles.get(key);
    if (!live.expert || (have && Date.now() - have.at < 12 * 3600_000)) return;
    this.profiles.set(key, { ...have, at: Date.now() });
    void live.expert
      .ask("Briefly, for my voice assistant: who am I, what's my role, and what am I mainly working on right now? Three short sentences at most.", AbortSignal.timeout(120_000))
      .then((text) => {
        const t = text.trim();
        if (t) this.profiles.set(key, { text: t.slice(0, 700), at: Date.now() });
        this.deps.logger?.info('profile ready', { chars: t.length });
      })
      .catch((err) => this.deps.logger?.warn('profile lookup failed', { error: String(err) }));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, live] of this.live) {
      if (live.clients.size === 0 && !live.desk?.running().length && now - live.lastUsed > this.idleMs) this.live.delete(key);
    }
  }
}
