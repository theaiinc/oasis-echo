import type { Logger } from '@oasis-echo/telemetry';
import { buildCorrectionPrompt, type SemanticCorrectorFn } from './semantic.js';

export type OllamaCorrectorOpts = {
  baseUrl?: string;
  model?: string;
  logger?: Logger;
};

/**
 * SemanticCorrectorFn factory that calls an Ollama endpoint with the
 * standard correction prompt. Uses `keep_alive: '30m'` so the model
 * stays hot between turns.
 */
export function makeOllamaCorrector(opts: OllamaCorrectorOpts = {}): SemanticCorrectorFn {
  const baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
  const model = opts.model ?? 'gemma4:e2b';

  return async (text, opts = {}) => {
    const { signal, agentContext } = opts;
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: buildCorrectionPrompt(text, agentContext),
        stream: false,
        think: false,
        keep_alive: '30m',
        options: { temperature: 0.1, num_predict: 200 },
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ollama corrector ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = (await res.json()) as { response?: string };
    const raw = (data.response ?? '').trim();
    // Strip a leading 'Corrected:' echo in case the model repeats the hint.
    return raw.replace(/^corrected\s*:\s*/i, '').trim();
  };
}
