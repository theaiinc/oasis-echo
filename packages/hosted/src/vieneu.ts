import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { StreamingTts, TtsChunk } from '@oasis-echo/coordinator';
import type { Logger } from '@oasis-echo/telemetry';

/**
 * Text with Vietnamese letters. Mostly letters only Vietnamese uses; â ê ô are shared
 * with French, which this voice path doesn't serve, and without them "vâng" is missed.
 */
export function isVietnamese(text: string): boolean {
  return /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu.test(text);
}

type Pending = { push: (pcm: Int16Array) => void; done: () => void; fail: (err: Error) => void };

/**
 * VieNeu-TTS (Vietnamese) through vieneu-bridge.py: one Python process, one
 * request at a time, chunks streamed back as they are made.
 */
export class VieneuTts implements StreamingTts {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private turn: Promise<void> = Promise.resolve();
  private onReady: ((rate: number) => void) | null = null;
  private onFailed: (() => void) | null = null;
  private starting: Promise<boolean> | null = null;
  private readonly waiters: Array<(ok: boolean) => void> = [];
  sampleRate = 48_000;

  /**
   * Nothing runs until something needs Vietnamese: loading and warming VieNeu takes
   * ~20 s of CPU, which an English call shouldn't compete with.
   */
  constructor(private readonly opts: { python: string; script: string; env?: NodeJS.ProcessEnv; logger?: Logger }) {}

  /** Start (once) and settle when it can speak (true) or never will (false). */
  get ready(): Promise<boolean> {
    this.starting ??= new Promise<boolean>((resolve) => {
      const settle = (ok: boolean) => {
        resolve(ok);
        for (const w of this.waiters.splice(0)) w(ok);
      };
      this.onReady = (rate) => { this.sampleRate = rate; settle(true); };
      this.onFailed = () => settle(false);
      try {
        this.start();
        this.proc!.stdin.write(JSON.stringify({ type: 'preload' }) + '\n');
      } catch (err) {
        this.opts.logger?.error('vieneu start failed', { error: String(err) });
        settle(false);
      }
      this.proc?.on('exit', () => settle(false));
      // A missing interpreter emits 'error'; unhandled, it would take the whole server down.
      this.proc?.on('error', (err) => {
        this.opts.logger?.error('vieneu start failed', { error: String(err) });
        settle(false);
      });
    });
    return this.starting;
  }

  /** Call back when it settles, without starting it. */
  whenReady(cb: (ok: boolean) => void): void {
    if (this.starting) void this.starting.then(cb);
    else this.waiters.push(cb);
  }

  private start(): void {
    const proc = spawn(this.opts.python, [this.opts.script], { env: { ...process.env, ...this.opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stderr.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line && !/warn/i.test(line)) this.opts.logger?.debug('vieneu', { line: line.slice(0, 300) });
    });
    proc.on('exit', (code) => {
      this.opts.logger?.warn('vieneu exited', { code });
      for (const p of this.pending.values()) p.fail(new Error(`vieneu exited (${code})`));
      this.pending.clear();
      this.proc = null;
    });
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg: { type: string; id?: string; pcm?: string; sampleRate?: number; message?: string };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'ready') return this.onReady?.(msg.sampleRate ?? 48_000);
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (msg.type === 'error') {
        this.opts.logger?.warn('vieneu error', { message: msg.message });
        // A failed preload means no Vietnamese voice; say so instead of leaving calls ringing.
        if (!msg.id) this.onFailed?.();
        if (p) { this.pending.delete(msg.id!); p.fail(new Error(msg.message ?? 'vieneu error')); }
        return;
      }
      if (!p) return;
      if (msg.type === 'chunk' && msg.pcm) {
        const bytes = Buffer.from(msg.pcm, 'base64');
        p.push(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
      } else if (msg.type === 'done') {
        this.pending.delete(msg.id!);
        p.done();
      }
    });
  }

  async *synthesize(text: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<TtsChunk> {
    // The bridge makes one reply at a time; wait for the one before.
    const previous = this.turn;
    let release!: () => void;
    this.turn = new Promise((r) => (release = r));
    try {
      await previous;
      if (!(await this.ready) || !this.proc) throw new Error('vieneu is not running');
      const id = `v${++this.seq}`;
      const queue: Int16Array[] = [];
      let finished = false;
      let failure: Error | null = null;
      let wake: (() => void) | null = null;
      this.pending.set(id, {
        push: (pcm) => { queue.push(pcm); wake?.(); },
        done: () => { finished = true; wake?.(); },
        fail: (err) => { failure = err; finished = true; wake?.(); },
      });
      this.proc.stdin.write(JSON.stringify({ type: 'say', id, text }) + '\n');
      // One chunk is held back so the last one can be marked final (a final chunk
      // with no audio would make the page speak the text itself).
      let held: Int16Array | null = null;
      // An abandoned reply still has to finish in the bridge; stop yielding it.
      while (!opts.signal?.aborted) {
        if (queue.length) {
          if (held) yield { text, pcm: held, sampleRate: this.sampleRate, final: false };
          held = queue.shift()!;
          continue;
        }
        if (finished) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      if (opts.signal?.aborted) {
        // Let it drain in the background before the next request goes in.
        await new Promise<void>((r) => { const p = this.pending.get(id); if (!p) return r(); this.pending.set(id, { push: () => {}, done: r, fail: () => r() }); });
        return;
      }
      if (failure) throw failure;
      if (held) yield { text, pcm: held, sampleRate: this.sampleRate, final: true };
    } finally {
      release();
    }
  }

  close(): void {
    this.proc?.kill();
  }
}
