export type FillerAdviceInput = {
  userText: string;
  reason: string;
  thinking: string;
  previousFillers: readonly string[];
};

export type FillerAdvisor = {
  advise(input: FillerAdviceInput): Promise<string | null>;
};

export type OllamaFillerAdvisorOpts = {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
};

export class OllamaFillerAdvisor implements FillerAdvisor {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaFillerAdvisorOpts = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.model = opts.model ?? 'qwen3:4b';
    this.timeoutMs = opts.timeoutMs ?? 2000;
  }

  async advise(input: FillerAdviceInput): Promise<string | null> {
    const thinking = input.thinking.trim();
    if (thinking.length === 0) return null;

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        keep_alive: '30m',
        think: false,
        messages: [
          {
            role: 'system',
            content: [
              'You write one short spoken wait phrase for a voice assistant.',
              'Use the hidden thinking context only to sound more relevant.',
              'Do not reveal the thinking. Do not answer the user.',
              'Return only the phrase, no quotes, no markdown.',
              'Keep it under 8 words.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `User asked: ${input.userText}`,
              `Reason: ${input.reason}`,
              `Already used: ${input.previousFillers.join(' | ') || 'none'}`,
              `Hidden thinking: ${thinking.slice(-900)}`,
              '',
              'Wait phrase:',
            ].join('\n'),
          },
        ],
        options: {
          temperature: 0.35,
          num_predict: 18,
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { message?: { content?: string } };
    return sanitizeFillerAdvice(data.message?.content ?? '');
  }
}

export function sanitizeFillerAdvice(raw: string): string | null {
  const cleaned = raw
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > 80) return null;
  if (/[{}[\]<>]/.test(cleaned)) return null;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 8) return null;
  if (/[.!?]$/.test(cleaned)) return cleaned;
  return `${cleaned}.`;
}
