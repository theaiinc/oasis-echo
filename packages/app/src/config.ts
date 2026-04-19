export type Backend = 'anthropic' | 'ollama' | 'openai';

export type TtsBackend = 'kokoro' | 'web-speech';

/**
 * Only one router option now: the SLM coordinator (Ollama-backed).
 * The former `heuristic` and `passthrough` routers were regex stubs
 * and have been removed.
 */
export type RouterBackend = 'slm';

export type RuntimeConfig = {
  sessionId: string;
  backend: Backend;
  model: string;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  ttsBackend: TtsBackend;
  kokoroVoice: string;
  kokoroDtype: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  router: RouterBackend;
  routerBaseUrl: string;
  routerModel: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  profile: 'm3pro-18gb' | 'm4max-64gb' | 'test';
};

/**
 * Backend resolution order (required — the server errors out if none
 * of these conditions are met):
 *   1. Explicit OASIS_BACKEND=anthropic|ollama|openai
 *   2. ANTHROPIC_API_KEY set → anthropic
 *   3. OPENAI_API_KEY    set → openai
 *   4. Fall back to ollama (assuming a local server is running)
 */
export function loadConfig(): RuntimeConfig {
  const explicit = process.env['OASIS_BACKEND'] as Backend | undefined;
  const backend: Backend =
    explicit === 'anthropic' || explicit === 'ollama' || explicit === 'openai'
      ? explicit
      : process.env['ANTHROPIC_API_KEY']
      ? 'anthropic'
      : process.env['OPENAI_API_KEY']
      ? 'openai'
      : 'ollama';

  const model =
    backend === 'anthropic'
      ? process.env['OASIS_MODEL'] ?? 'claude-sonnet-4-6'
      : backend === 'openai'
      ? process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini'
      : process.env['OLLAMA_MODEL'] ?? 'gemma4:e2b';

  const ttsBackend: TtsBackend =
    (process.env['OASIS_TTS_BACKEND'] as TtsBackend | undefined) === 'kokoro'
      ? 'kokoro'
      : 'web-speech';

  // The SLM router always runs on Ollama (it needs JSON-structured
  // output and a small-model TTFT). Default to the same Ollama server
  // the reasoner uses when that's local, else fall back to localhost.
  const routerBaseUrl =
    process.env['OASIS_ROUTER_BASE_URL'] ??
    (backend === 'ollama'
      ? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
      : 'http://localhost:11434');

  return {
    sessionId: process.env['OASIS_SESSION_ID'] ?? `sess-${Date.now().toString(36)}`,
    backend,
    model,
    ollamaBaseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    openaiBaseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
    ttsBackend,
    kokoroVoice: process.env['KOKORO_VOICE'] ?? 'af_heart',
    kokoroDtype: (process.env['KOKORO_DTYPE'] as RuntimeConfig['kokoroDtype']) ?? 'q8',
    router: 'slm',
    routerBaseUrl,
    routerModel: process.env['OASIS_ROUTER_MODEL'] ?? (backend === 'ollama' ? model : 'gemma4:e2b'),
    logLevel: (process.env['OASIS_LOG_LEVEL'] as RuntimeConfig['logLevel']) ?? 'info',
    profile: (process.env['OASIS_PROFILE'] as RuntimeConfig['profile']) ?? 'm3pro-18gb',
  };
}
