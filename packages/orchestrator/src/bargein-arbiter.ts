import type { Logger, Metrics } from '@oasis-echo/telemetry';
import type { EventBus } from './event-bus.js';

/**
 * Tracks whether a turn is currently speaking to the user, and when a
 * barge-in fires, cancels everything downstream: LLM stream, TTS
 * playback, and audio buffers. The arbiter owns the AbortController
 * for each in-flight turn.
 */
export class BargeInArbiter {
  private activeTurnId: string | null = null;
  private activeController: AbortController | null = null;
  private bufferFlush: (() => void | Promise<void>) | null = null;
  private readonly logger: Logger | undefined;
  private readonly metrics: Metrics | undefined;

  constructor(
    private readonly bus: EventBus,
    opts: { logger?: Logger; metrics?: Metrics } = {},
  ) {
    this.logger = opts.logger;
    this.metrics = opts.metrics;
  }

  beginTurn(turnId: string, flush: () => void | Promise<void>): AbortSignal {
    if (this.activeController) this.activeController.abort('new-turn');
    this.activeTurnId = turnId;
    this.activeController = new AbortController();
    this.bufferFlush = flush;
    return this.activeController.signal;
  }

  endTurn(turnId: string): void {
    if (this.activeTurnId === turnId) {
      this.activeTurnId = null;
      this.activeController = null;
      this.bufferFlush = null;
    }
  }

  get isSpeaking(): boolean {
    return this.activeTurnId !== null;
  }

  async bargeIn(atMs: number): Promise<boolean> {
    if (!this.activeTurnId || !this.activeController) return false;
    const interruptedTurnId = this.activeTurnId;
    this.logger?.info('barge-in', { turnId: interruptedTurnId });
    this.metrics?.inc('bargein_total');
    this.activeController.abort('bargein');
    try {
      await this.bufferFlush?.();
    } catch (err) {
      this.logger?.warn('flush failed', { error: String(err) });
    }
    this.activeTurnId = null;
    this.activeController = null;
    this.bufferFlush = null;
    await this.bus.emit({ type: 'bargein', atMs, interruptedTurnId });
    return true;
  }
}
