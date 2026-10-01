/**
 * A provider rejected our credentials (HTTP 401/403). Unlike a timeout
 * or 5xx this will not heal on retry, so reasoners throw it without
 * counting it toward the circuit breaker, and the pipeline tells the
 * user their API key was rejected instead of a generic apology.
 */
export class ReasonerAuthError extends Error {
  override readonly name = 'ReasonerAuthError';
  readonly code = 'llm_auth';

  constructor(
    readonly provider: string,
    readonly status: number,
    detail = '',
  ) {
    super(`${provider} API key rejected (HTTP ${status})${detail ? `: ${detail}` : ''}`);
  }
}

export function isAuthStatus(status: unknown): status is 401 | 403 {
  return status === 401 || status === 403;
}

/** Matches across package boundaries (duck-typed on `name`). */
export function isReasonerAuthError(err: unknown): err is ReasonerAuthError {
  return err instanceof Error && err.name === 'ReasonerAuthError';
}
