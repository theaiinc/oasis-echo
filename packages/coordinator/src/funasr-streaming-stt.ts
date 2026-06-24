import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@oasis-echo/telemetry';

/**
 * Streaming speech-to-text via FunASR (SenseVoiceSmall) in a Python
 * subprocess bridge.
 *
 * Same public API as `WhisperStreamingStt` — feed PCM frames, produce
 * partial transcripts, finalize the utterance.
 *
 * Input: `Float32Array` samples at 16 kHz mono, range [-1, 1].
 */
export type FunasrStreamingSttOpts = {
  /** Path to the Python interpreter. Default: repo-local .venv-funasr. */
  pythonPath?: string;
  /** Max seconds of audio to keep in the rolling buffer. Default 30. */
  maxBufferSeconds?: number;
  /**
   * How often to produce a partial once there's enough audio. Default 900ms.
   */
  partialEveryMs?: number;
  /** Minimum buffered audio before running inference. Default 1.2s. */
  minBufferSeconds?: number;
  logger?: Logger;
};

const SAMPLE_RATE = 16000;

/**
 * A JSON response from the Python bridge process.
 */
type BridgeResponse =
  | { type: 'ready' }
  | { type: 'ack' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string };

/**
 * One instance per active session / WebSocket connection. Not thread-
 * safe — caller serializes feed() / partial() calls.
 */
export class FunasrStreamingStt {
  private readonly maxBufferSamples: number;
  private readonly partialEveryMs: number;
  private readonly minBufferSamples: number;
  private readonly logger: Logger | undefined;
  private readonly pythonPath: string;
  private readonly bridgeScript: string;

  private proc: ChildProcess | null = null;
  private ready = false;
  private loadFailed = false;
  private loadPromise: Promise<boolean> | null = null;

  // Rolling buffer + committed segments (mirrors WhisperStreamingStt).
  private buffer = new Float32Array(0);
  private lastPartialAt = 0;
  private lastPartialText = '';
  private committedSegments = '';
  private headCommitPromise: Promise<void> | null = null;

  // Subprocess communication.
  private responseQueue: Array<{
    resolve: (val: BridgeResponse) => void;
    reject: (err: Error) => void;
  }> = [];
  private lineBuffer = '';
  private processExited = false;

  constructor(opts: FunasrStreamingSttOpts = {}) {
    this.maxBufferSamples = (opts.maxBufferSeconds ?? 30) * SAMPLE_RATE;
    this.partialEveryMs = opts.partialEveryMs ?? 900;
    this.minBufferSamples = (opts.minBufferSeconds ?? 1.2) * SAMPLE_RATE;
    this.logger = opts.logger;

    // Resolve python path — prefer the repo-level venv, then fall back to
    // whatever is on PATH.
    const modulePath = fileURLToPath(import.meta.url);
    const packageRoot = resolve(dirname(modulePath), '..');
    const repoRoot = resolve(packageRoot, '..', '..');
    this.pythonPath =
      opts.pythonPath ?? join(repoRoot, '.venv-funasr', 'bin', 'python3');

    // The bridge script lives alongside the TypeScript source.
    this.bridgeScript = join(packageRoot, 'src', 'funasr-bridge.py');
  }

  // ------------------------------------------------------------------
  // Public API — matches WhisperStreamingStt
  // ------------------------------------------------------------------

  /** Ensure the Python process + model are loaded. */
  preload(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.loadFailed) return Promise.resolve(false);
    if (!this.loadPromise) {
      this.loadPromise = this.spawnAndLoad();
    }
    return this.loadPromise;
  }

  /** Append PCM (Float32, 16 kHz mono, range [-1, 1]) to the buffer. */
  feed(samples: Float32Array): void {
    if (!samples.length) return;
    const needed = this.buffer.length + samples.length;
    if (needed <= this.maxBufferSamples) {
      const merged = new Float32Array(needed);
      merged.set(this.buffer, 0);
      merged.set(samples, this.buffer.length);
      this.buffer = merged;
      return;
    }
    // Overflow — transcribe the head we're about to drop, then keep the tail.
    const dropCount = needed - this.maxBufferSamples;
    const droppedHead = this.buffer.subarray(0, dropCount);
    const keepFromExisting = Math.max(
      0,
      this.maxBufferSamples - samples.length,
    );
    const merged = new Float32Array(keepFromExisting + samples.length);
    if (keepFromExisting > 0) {
      merged.set(
        this.buffer.subarray(this.buffer.length - keepFromExisting),
        0,
      );
    }
    merged.set(samples, keepFromExisting);
    this.buffer = merged;
    this.commitDroppedHead(droppedHead);
  }

  /** Duration of buffered audio in seconds. */
  get bufferSeconds(): number {
    return this.buffer.length / SAMPLE_RATE;
  }

  /**
   * Try to produce a partial transcription. Returns `null` if:
   *   - not enough audio buffered, OR
   *   - model not loaded yet, OR
   *   - it's been less than `partialEveryMs` since the last partial AND
   *     `force` is false.
   */
  async partial(force = false): Promise<string | null> {
    if (this.buffer.length < this.minBufferSamples) return null;
    const now = Date.now();
    if (!force && now - this.lastPartialAt < this.partialEveryMs) return null;
    const ok = await this.preload();
    if (!ok) return null;
    this.lastPartialAt = now;
    const text = await this.runInference(this.buffer, 'partial');
    this.lastPartialText = text;
    return this.joinCommitted(text);
  }

  /** Best available transcript of the entire buffer. Always runs a fresh inference. */
  async transcribeAll(): Promise<string> {
    await this.awaitHeadCommits();
    if (this.buffer.length < this.minBufferSamples) {
      return this.joinCommitted(this.lastPartialText);
    }
    const ok = await this.preload();
    if (!ok) return this.joinCommitted(this.lastPartialText);
    const text = await this.runInference(this.buffer, 'finalize');
    this.lastPartialText = text;
    return this.joinCommitted(text);
  }

  /** Drop the rolling buffer — start fresh for a new utterance. */
  reset(): void {
    this.buffer = new Float32Array(0);
    this.lastPartialAt = 0;
    this.lastPartialText = '';
    this.committedSegments = '';
    this.headCommitPromise = null;
    // Also tell the Python bridge to reset its buffer.
    this.sendCommand({ type: 'reset' }).catch(() => {
      /* ignore — process may not be alive yet */
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private joinCommitted(tail: string): string {
    const t = tail.trim();
    if (!this.committedSegments) return t;
    if (!t) return this.committedSegments;
    return `${this.committedSegments} ${t}`.trim();
  }

  private async awaitHeadCommits(): Promise<void> {
    if (this.headCommitPromise) {
      await this.headCommitPromise;
    }
  }

  private commitDroppedHead(head: Float32Array): void {
    if (head.length < this.minBufferSamples) return;
    const prev = this.headCommitPromise;
    this.headCommitPromise = (async () => {
      if (prev) await prev;
      try {
        const text = (await this.runInference(head, 'partial')).trim();
        if (!text) return;
        this.committedSegments = this.committedSegments
          ? `${this.committedSegments} ${text}`
          : text;
      } catch {
        /* best-effort */
      }
    })();
  }

  /**
   * Send the current buffer to the bridge and run inference.
   *
   * Two messages: `feed` (replace bridge buffer) then `partial` or
   * `finalize` depending on `mode`.
   */
  private async runInference(
    samples: Float32Array,
    mode: 'partial' | 'finalize',
  ): Promise<string> {
    const b64 = Buffer.from(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength,
    ).toString('base64');

    const feedResp = await this.sendCommand({
      type: 'feed',
      samples: b64,
    });
    if (!feedResp || feedResp.type === 'error') {
      this.logger?.warn('funasr feed failed', {
        error:
          feedResp && feedResp.type === 'error'
            ? String(feedResp.message)
            : 'no response',
      });
      return this.lastPartialText;
    }

    const inferResp = await this.sendCommand({
      type: mode,
    });
    if (!inferResp || inferResp.type === 'error') {
      this.logger?.warn(`funasr ${mode} failed`, {
        error:
          inferResp && inferResp.type === 'error'
            ? String(inferResp.message)
            : 'no response',
      });
      return this.lastPartialText;
    }
    if (inferResp.type === 'partial' || inferResp.type === 'final') {
      return inferResp.text;
    }
    return this.lastPartialText;
  }

  // ------------------------------------------------------------------
  // Subprocess management
  // ------------------------------------------------------------------

  private async spawnAndLoad(): Promise<boolean> {
    try {
      this.spawnProcess();
      const resp = await this.sendCommand({ type: 'preload' });
      if (resp && resp.type === 'ready') {
        this.ready = true;
        this.logger?.info('funasr-stt ready', {
          python: this.pythonPath,
          model: 'iic/SenseVoiceSmall',
        });
        return true;
      }
      throw new Error(
        resp?.type === 'error'
          ? String(resp.message)
          : 'unexpected preload response',
      );
    } catch (err) {
      this.loadFailed = true;
      this.logger?.warn('funasr-stt load failed', { error: String(err) });
      return false;
    }
  }

  private spawnProcess(): void {
    if (this.proc) return;
    this.processExited = false;

    const proc = spawn(this.pythonPath, [this.bridgeScript], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.proc = proc;

    proc.stdout!.on('data', (data: Buffer) => {
      this.onStdoutData(data);
    });

    proc.on('exit', (code, signal) => {
      this.processExited = true;
      this.proc = null;
      this.ready = false;
      // Reject any pending response promises so callers don't hang forever.
      this.drainResponseQueue(
        new Error(
          `Python process exited (code=${code}, signal=${String(signal)})`,
        ),
      );
      this.logger?.warn('funasr-stt process exited', {
        code,
        signal: signal ?? undefined,
      });
    });

    proc.on('error', (err) => {
      this.processExited = true;
      this.proc = null;
      this.ready = false;
      this.drainResponseQueue(
        new Error(`Python process error: ${err.message}`),
      );
      this.logger?.warn('funasr-stt process error', {
        error: err.message,
      });
    });
  }

  private drainResponseQueue(err: Error): void {
    while (this.responseQueue.length > 0) {
      const pending = this.responseQueue.shift()!;
      pending.reject(err);
    }
  }

  private onStdoutData(data: Buffer): void {
    this.lineBuffer += data.toString('utf-8');
    const lines = this.lineBuffer.split('\n');
    // Keep the last (possibly incomplete) line in the buffer.
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const response = JSON.parse(trimmed) as BridgeResponse;
        const pending = this.responseQueue.shift();
        if (pending) pending.resolve(response);
      } catch (err) {
        const pending = this.responseQueue.shift();
        if (pending)
          pending.reject(new Error(`Invalid JSON from bridge: ${trimmed}`));
      }
    }
  }

  private async sendCommand(cmd: object): Promise<BridgeResponse> {
    if (!this.proc || !this.proc.stdin || this.processExited) {
      throw new Error('Python bridge process is not running');
    }
    return new Promise<BridgeResponse>((resolve, reject) => {
      this.responseQueue.push({ resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(cmd) + '\n');
    });
  }
}
