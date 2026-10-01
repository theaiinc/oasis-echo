/**
 * Asking a slow expert (Maya) without holding up the call. The talker hands
 * a question to the desk, which answers at once with how long the expert
 * usually takes; the call goes on, and the desk reports progress and the
 * answer when it comes.
 */

/** How long an expert takes, from how long it has actually taken (median of recent answers). */
export class LatencyEstimate {
  private readonly recent: number[] = [];

  constructor(private readonly priorMs: number, private readonly keep = 12) {}

  record(ms: number): void {
    this.recent.push(ms);
    if (this.recent.length > this.keep) this.recent.shift();
  }

  /** Expected time to an answer. */
  typicalMs(): number {
    if (this.recent.length === 0) return this.priorMs;
    const sorted = [...this.recent].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  /** A pessimistic bound: the slowest recent answer (or 1.5× the prior). */
  slowMs(): number {
    return this.recent.length ? Math.max(...this.recent) : this.priorMs * 1.5;
  }

  get samples(): number {
    return this.recent.length;
  }
}

export type ExpertJob = {
  id: string;
  question: string;
  startedAt: number;
  status: 'running' | 'done' | 'failed';
  answer?: string;
  error?: string;
  /** Progress notes already given for this job. */
  updates: number;
  /** The answer was spoken to the user (the notes then carry what was said, not the raw answer). */
  delivered?: boolean;
};

export type DeskEvents = {
  /** The expert answered (or failed): tell the user. */
  answered: (job: ExpertJob) => void;
  /** Taking longer than expected: say so (at most twice per job). */
  late: (job: ExpertJob, overMs: number) => void;
  /** Before it is due: a short "still working" note, so the call isn't silent while waiting. */
  progress?: (job: ExpertJob, n: number) => void;
};

export class ExpertDesk {
  private readonly jobs: ExpertJob[] = [];
  private seq = 0;

  constructor(
    readonly name: string,
    private readonly ask: (question: string, signal: AbortSignal) => Promise<string>,
    readonly estimate: LatencyEstimate,
    private readonly events: DeskEvents,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start asking; returns what the talker should know right away. */
  start(question: string): { job: ExpertJob; etaSeconds: number; alreadyAsked: boolean } {
    const q = question.trim();
    const running = this.jobs.find((j) => j.status === 'running' && same(j.question, q));
    if (running) return { job: running, etaSeconds: this.remainingSeconds(running), alreadyAsked: true };
    const job: ExpertJob = { id: `x${++this.seq}`, question: q, startedAt: this.now(), status: 'running', updates: 0 };
    this.jobs.push(job);
    while (this.jobs.length > 20) this.jobs.shift();
    const abort = new AbortController();
    const lateTimers = [1, 2].map((n) =>
      setTimeout(() => {
        if (job.status !== 'running' || job.updates >= n) return;
        job.updates = n;
        this.events.late(job, this.now() - job.startedAt - this.estimate.typicalMs());
      }, this.estimate.typicalMs() * (n === 1 ? 1.15 : 2)),
    );
    const typical = this.estimate.typicalMs();
    if (this.events.progress) {
      [0.3, 0.65].forEach((at, i) => {
        const delay = Math.max(12_000, typical * at);
        if (delay >= typical) return;
        lateTimers.push(setTimeout(() => {
          if (job.status === 'running') this.events.progress?.(job, i + 1);
        }, delay));
      });
    }
    lateTimers.forEach((t) => (t as { unref?: () => void }).unref?.());
    void this.ask(q, abort.signal).then(
      (answer) => {
        job.status = 'done';
        job.answer = answer;
        this.estimate.record(this.now() - job.startedAt);
      },
      (err) => {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      },
    ).finally(() => {
      lateTimers.forEach(clearTimeout);
      this.events.answered(job);
    });
    return { job, etaSeconds: Math.round(this.estimate.typicalMs() / 1000), alreadyAsked: false };
  }

  running(): ExpertJob[] {
    return this.jobs.filter((j) => j.status === 'running');
  }

  remainingSeconds(job: ExpertJob): number {
    return Math.max(0, Math.round((job.startedAt + this.estimate.typicalMs() - this.now()) / 1000));
  }

  /** What the talker should know every turn: what is being worked on, and for how long yet. */
  contextNote(): string | undefined {
    const running = this.running();
    const recent = this.jobs.filter((j) => j.status !== 'running' && this.now() - j.startedAt < 15 * 60_000).slice(-3);
    if (!running.length && !recent.length) return undefined;
    const lines = running.map((j) => {
      const asked = Math.round((this.now() - j.startedAt) / 1000);
      const left = this.remainingSeconds(j);
      return `- ${this.name} is working on "${j.question}" (asked ${asked}s ago; ${left > 0 ? `about ${left}s left` : 'running late'}).`;
    });
    for (const j of recent) {
      lines.push(j.status !== 'done'
        ? `- Asking ${this.name} "${j.question}" failed (${j.error}).`
        : j.delivered
          ? `- "${j.question}" is answered and already told to the user (see what you told them).`
          : `- ${this.name} answered "${j.question}": ${clip(j.answer ?? '', 600)}`);
    }
    return `Background work with ${this.name}:\n${lines.join('\n')}`;
  }
}

function same(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return norm(a) === norm(b);
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * The desk's spoken notes are fixed lines without the expert's name, so they are
 * baked into the image with the fillers and play at once; the name would need
 * runtime synthesis, which starved the first call after a cold start.
 */

/** A "still working" note before the answer is due, spoken without a model call. */
export function progressNote(n: number, lang: 'en' | 'vi' = 'en'): string {
  if (lang === 'vi') {
    return n <= 1 ? 'Mình vẫn đang chờ câu trả lời, sắp có rồi.' : 'Vẫn đang tổng hợp. Trong lúc chờ, bạn cần gì thêm không?';
  }
  return n <= 1
    ? "I'm still waiting on that answer. It's coming together."
    : "It's still being pulled together. Anything else while we wait?";
}

/** Every fixed line the desk may speak, so the voice can prepare them ahead of time. */
export function deskPhrases(): string[] {
  return (['en', 'vi'] as const).flatMap((lang) => [
    progressNote(1, lang), progressNote(2, lang), lateNote(0, 0, lang), lateNote(30_000, 0, lang), lateNote(0, 2, lang),
  ]);
}

/** A progress note for a late job, spoken without a model call. */
export function lateNote(overMs: number, updates: number, lang: 'en' | 'vi' = 'en'): string {
  if (lang === 'vi') {
    if (updates >= 2) return 'Vẫn đang làm. Có kết quả là mình báo bạn ngay.';
    return overMs > 20_000
      ? 'Lần này lâu hơn mọi khi. Mình vẫn đang chờ, có là báo bạn ngay.'
      : 'Sắp xong rồi. Có kết quả là mình báo bạn ngay.';
  }
  if (updates >= 2) return "Still on it. I'll tell you the moment the answer comes in.";
  return overMs > 20_000
    ? "This one is taking longer than usual. I'm still waiting, and I'll tell you as soon as the answer comes in."
    : "Almost there. I'll tell you as soon as the answer comes in.";
}
