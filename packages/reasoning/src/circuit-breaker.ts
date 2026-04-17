export type CircuitState = 'closed' | 'open' | 'half-open';

export type CircuitBreakerOpts = {
  failureThreshold?: number;
  openDurationMs?: number;
  now?: () => number;
};

/**
 * Opens after N consecutive failures and blocks calls for a cooldown
 * window. Transitions to half-open on the next attempt; a single
 * success closes the circuit.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOpts = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.openDurationMs = opts.openDurationMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  canAttempt(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'half-open') return true;
    if (this.now() - this.openedAtMs >= this.openDurationMs) {
      this.state = 'half-open';
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAtMs = this.now();
    }
  }

  get status(): CircuitState {
    return this.state;
  }
}
