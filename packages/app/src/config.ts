export type Backend = 'anthropic' | 'ollama' | 'openai';

export type TtsBackend = 'kokoro' | 'web-speech';

export type SttBackend = 'whisper' | 'funasr';

/**
 * Only one router option now: the SLM coordinator (Ollama-backed).
 * The former `heuristic` and `passthrough` routers were regex stubs
 * and have been removed.
 */
export type RouterBackend = 'slm';

export type RuntimeConfig = {
  sessionId: string;
  version: string;
  backend: Backend;
  model: string;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  ttsBackend: TtsBackend;
  sttBackend: SttBackend;
  kokoroVoice: string;
  kokoroDtype: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  router: RouterBackend;
  routerBaseUrl: string;
  routerModel: string;
  mediumReasonerModel: string | undefined;
  reasonerTimeoutMs: number;
  /** LM Studio base URL for Arch-Router classifier (OpenAI-compatible). */
  archBaseUrl: string;
  /** Arch-Router model ID as registered in LM Studio. */
  archModel: string;
  archTimeoutMs: number;
  slmTimeoutMs: number;
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
    version: process.env['npm_package_version'] ?? '0.1.0',
    backend,
    model,
    ollamaBaseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    openaiBaseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
    ttsBackend,
    sttBackend:
      (process.env['OASIS_STT_BACKEND'] as SttBackend | undefined) === 'funasr'
        ? 'funasr'
        : 'whisper',
    kokoroVoice: process.env['KOKORO_VOICE'] ?? 'af_heart',
    kokoroDtype: (process.env['KOKORO_DTYPE'] as RuntimeConfig['kokoroDtype']) ?? 'q8',
    router: 'slm',
    routerBaseUrl,
    routerModel: process.env['OASIS_ROUTER_MODEL'] ?? (backend === 'ollama' ? model : 'qwen3:4b'),
    mediumReasonerModel: process.env['OASIS_MEDIUM_REASONER_MODEL']?.trim() || undefined,
    reasonerTimeoutMs: Number(process.env['OASIS_REASONER_TIMEOUT_MS'] ?? 120_000),
    // Arch-Router 1.5B runs on LM Studio (OpenAI-compatible API).
    // Default to localhost:1234/v1 with model ID as loaded in LM Studio.
    archBaseUrl:
      process.env['OASIS_ARCH_BASE_URL'] ??
      process.env['OPENAI_BASE_URL'] ??
      'http://localhost:1234/v1',
    archModel:
      process.env['OASIS_ARCH_MODEL'] ?? 'arch-router-1.5b.gguf',
    archTimeoutMs: Number(process.env['OASIS_ARCH_TIMEOUT_MS'] ?? 15_000),
    slmTimeoutMs: Number(process.env['OASIS_SLM_TIMEOUT_MS'] ?? 20_000),
    logLevel: (process.env['OASIS_LOG_LEVEL'] as RuntimeConfig['logLevel']) ?? 'info',
    profile: (process.env['OASIS_PROFILE'] as RuntimeConfig['profile']) ?? 'm3pro-18gb',
  };
}
