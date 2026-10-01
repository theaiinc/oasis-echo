/**
 * Tool-result error for a failed Home Assistant API call. A 401/403
 * means HA_TOKEN was rejected (revoked/expired/wrong) — say so plainly
 * instead of a generic API error, so the user knows to fix the token.
 */
export function haApiError(res: { status: number; statusText: string }): { error: string; code?: string } {
  if (res.status === 401 || res.status === 403) {
    return {
      error: `Home Assistant token was rejected (HTTP ${res.status}) — check HA_TOKEN`,
      code: 'ha_auth',
    };
  }
  return { error: `HA API error: ${res.status} ${res.statusText}` };
}
