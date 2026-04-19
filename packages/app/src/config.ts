export type Backend = 'anthropic' | 'ollama' | 'openai' | 'mock';

export type TtsBackend = 'kokoro' | 'web-speech';

export type RouterBackend = 'slm' | 'passthrough' | 'heuristic';

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
  routerModel: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  profile: 'm3pro-18gb' | 'm4max-64gb' | 'test';
};

/**
 * Backend resolution order:
 *   1. Explicit OASIS_BACKEND=anthropic|ollama|openai|mock
 *   2. ANTHROPIC_API_KEY  set → anthropic
 *   3. OPENAI_API_KEY    set → openai
 *   4. otherwise             → mock
 *
 * Both `ollama` and `openai` backends hit local model servers or
 * OpenAI-compatible endpoints (LM Studio, vLLM, OpenRouter, Together,
 * Groq, DeepSeek, Mistral, etc. via OPENAI_BASE_URL).
 */
export function loadConfig(): RuntimeConfig {
  const explicit = process.env['OASIS_BACKEND'] as Backend | undefined;
  const backend: Backend =
    explicit === 'anthropic' ||
    explicit === 'ollama' ||
    explicit === 'openai' ||
    explicit === 'mock'
      ? explicit
      : process.env['ANTHROPIC_API_KEY']
      ? 'anthropic'
      : process.env['OPENAI_API_KEY']
      ? 'openai'
      : 'mock';

  const model =
    backend === 'anthropic'
      ? process.env['OASIS_MODEL'] ?? 'claude-sonnet-4-6'
      : backend === 'ollama'
      ? process.env['OLLAMA_MODEL'] ?? 'gemma4:e4b'
      : backend === 'openai'
      ? process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini'
      : 'mock';

  const ttsBackend: TtsBackend =
    (process.env['OASIS_TTS_BACKEND'] as TtsBackend | undefined) === 'kokoro' ? 'kokoro' : 'web-speech';

  // Router resolution:
  //   1. Explicit OASIS_ROUTER=slm|passthrough|heuristic
  //   2. Ollama backend available → slm (uses Ollama for routing too)
  //   3. mock backend → heuristic (regex)
  const explicitRouter = process.env['OASIS_ROUTER'] as RouterBackend | undefined;
  const router: RouterBackend =
    explicitRouter === 'slm' || explicitRouter === 'passthrough' || explicitRouter === 'heuristic'
      ? explicitRouter
      : backend === 'ollama'
      ? 'slm'
      : backend === 'anthropic'
      ? 'passthrough'
      : 'heuristic';

  return {
    sessionId: process.env['OASIS_SESSION_ID'] ?? `sess-${Date.now().toString(36)}`,
    backend,
    model,
    ollamaBaseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    openaiBaseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
    ttsBackend,
    kokoroVoice: process.env['KOKORO_VOICE'] ?? 'af_heart',
    kokoroDtype: (process.env['KOKORO_DTYPE'] as RuntimeConfig['kokoroDtype']) ?? 'q8',
    router,
    routerModel:
      process.env['OASIS_ROUTER_MODEL'] ??
      (backend === 'ollama' ? model : 'gemma4:e2b'),
    logLevel: (process.env['OASIS_LOG_LEVEL'] as RuntimeConfig['logLevel']) ?? 'info',
    profile: (process.env['OASIS_PROFILE'] as RuntimeConfig['profile']) ?? 'm3pro-18gb',
  };
}
