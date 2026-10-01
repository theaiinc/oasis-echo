import { describe, expect, it } from 'vitest';
import { haApiError } from '../src/ha-errors.js';

describe('haApiError', () => {
  it.each([401, 403])('reports a rejected HA_TOKEN distinctly on %i', (status) => {
    const result = haApiError({ status, statusText: 'Unauthorized' });
    expect(result.code).toBe('ha_auth');
    expect(result.error).toContain('Home Assistant token was rejected');
    expect(result.error).toContain('HA_TOKEN');
  });

  it('keeps the generic error for other failures', () => {
    expect(haApiError({ status: 404, statusText: 'Not Found' })).toEqual({
      error: 'HA API error: 404 Not Found',
    });
  });
});
