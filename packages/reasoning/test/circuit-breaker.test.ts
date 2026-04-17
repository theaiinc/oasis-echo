import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed and allows attempts', () => {
    const b = new CircuitBreaker();
    expect(b.canAttempt()).toBe(true);
    expect(b.status).toBe('closed');
  });

  it('opens after threshold failures', () => {
    const b = new CircuitBreaker({ failureThreshold: 2, openDurationMs: 1000 });
    b.recordFailure();
    expect(b.status).toBe('closed');
    b.recordFailure();
    expect(b.status).toBe('open');
    expect(b.canAttempt()).toBe(false);
  });

  it('transitions to half-open after cooldown', () => {
    let now = 1000;
    const b = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 500, now: () => now });
    b.recordFailure();
    expect(b.canAttempt()).toBe(false);
    now += 600;
    expect(b.canAttempt()).toBe(true);
    expect(b.status).toBe('half-open');
  });

  it('closes on success', () => {
    const b = new CircuitBreaker({ failureThreshold: 2 });
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    expect(b.status).toBe('closed');
  });
});
