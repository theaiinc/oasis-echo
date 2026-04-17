export type RuntimeConfig = {
  sessionId: string;
  cloudEnabled: boolean;
  model: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  profile: 'm3pro-18gb' | 'm4max-64gb' | 'test';
};

export function loadConfig(): RuntimeConfig {
  return {
    sessionId: process.env['OASIS_SESSION_ID'] ?? `sess-${Date.now().toString(36)}`,
    cloudEnabled: Boolean(process.env['ANTHROPIC_API_KEY']),
    model: process.env['OASIS_MODEL'] ?? 'claude-sonnet-4-6',
    logLevel: (process.env['OASIS_LOG_LEVEL'] as RuntimeConfig['logLevel']) ?? 'info',
    profile: (process.env['OASIS_PROFILE'] as RuntimeConfig['profile']) ?? 'm3pro-18gb',
  };
}
