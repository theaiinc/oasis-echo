import { detectTopicChange } from './context-gate.js';
import type { AgentContext, PostProcessContext, PostProcessStage, PostProcessStepResult } from './types.js';

export type SemanticCorrectorFn = (
  text: string,
  opts?: { signal?: AbortSignal; agentContext?: AgentContext },
) => Promise<string>;

export type SemanticCorrectionOpts = {
  correct: SemanticCorrectorFn;
  /**
   * Only invoke the LLM when STT confidence is below this threshold.
   * Use `null` to always run. Default 0.6.
   */
  minConfidenceToRun?: number | null;
  /**
   * If text contains any of these markers of ambiguity (e.g. unusual
   * spellings, telltale STT garbage), force semantic correction even
   * if confidence is high.
   */
  ambiguityMarkers?: RegExp[];
  /** Bail out of the correction call after this many ms. Default 2500. */
  timeoutMs?: number;
  /** Minimum input length (chars) to consider. Short inputs skip. Default 6. */
  minInputChars?: number;
};

const DEFAULT_AMBIGUITY: RegExp[] = [
  /\b(?:uh+|um+|eh+)\b/i,      // residual fillers the rule stage missed
  /\b(\w+)\s+\1\b/i,            // duplicated words
  /\s[a-z]{1,2}\s[a-z]{1,2}\s/, // run of very short tokens = often garbled
];

/**
 * Conditional LLM-backed correction stage. Designed to run LAST, only
 * when the cheaper stages have low confidence in their output.
 *
 * The `correct` function is injected so callers pick the model (Ollama,
 * Anthropic, OpenAI, local ONNX grammar model). Default prompt in
 * `buildCorrectionPrompt` below.
 *
 * When agent context is supplied and the topic hasn't changed, the
 * stage forwards that context to the corrector so the LLM can bias
 * toward names / identifiers from the agent's last utterance.
 */
export class SemanticCorrectionStage implements PostProcessStage {
  readonly name = 'semantic';
  private readonly correct: SemanticCorrectorFn;
  private readonly minConfidenceToRun: number | null;
  private readonly ambiguityMarkers: RegExp[];
  private readonly timeoutMs: number;
  private readonly minInputChars: number;

  constructor(opts: SemanticCorrectionOpts) {
    this.correct = opts.correct;
    this.minConfidenceToRun =
      opts.minConfidenceToRun === undefined ? 0.6 : opts.minConfidenceToRun;
    this.ambiguityMarkers = opts.ambiguityMarkers ?? DEFAULT_AMBIGUITY;
    this.timeoutMs = opts.timeoutMs ?? 2500;
    this.minInputChars = opts.minInputChars ?? 6;
  }

  shouldRun(ctx: PostProcessContext): boolean {
    if (ctx.text.length < this.minInputChars) return false;
    if (this.minConfidenceToRun === null) return true;
    // When agent context is present AND the topic hasn't changed, always
    // run — the cheap heuristics miss shattered STT renderings of
    // multi-syllable names, and the LLM + context is our best shot.
    if (
      ctx.agentContext?.lastUtterance &&
      !detectTopicChange(ctx.text, ctx.agentContext).changed
    ) {
      return true;
    }
    const conf = ctx.confidence ?? 1;
    if (conf < this.minConfidenceToRun) return true;
    // Confidence looks fine — still check structural ambiguity markers.
    return this.ambiguityMarkers.some((re) => re.test(ctx.text));
  }

  async run(ctx: PostProcessContext): Promise<PostProcessStepResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    // Only pass agent context through if the topic hasn't changed —
    // otherwise the LLM would bias toward unrelated vocabulary.
    const agentContext =
      ctx.agentContext && !detectTopicChange(ctx.text, ctx.agentContext).changed
        ? ctx.agentContext
        : undefined;
    try {
      const corrected = (
        await this.correct(ctx.text, { signal: ctrl.signal, ...(agentContext ? { agentContext } : {}) })
      ).trim();
      if (!corrected || corrected === ctx.text) {
        return { text: ctx.text, changed: false, info: { reason: 'no-change' } };
      }
      // Guardrail: LLM drifting into a totally different length often
      // means it hallucinated. Reject if it tripled or dropped to 10%.
      const ratio = corrected.length / Math.max(1, ctx.text.length);
      if (ratio > 3 || ratio < 0.1) {
        return { text: ctx.text, changed: false, info: { reason: 'length-drift', ratio } };
      }
      return {
        text: corrected,
        changed: true,
        info: agentContext ? { usedAgentContext: true } : {},
      };
    } catch (err) {
      return { text: ctx.text, changed: false, info: { error: String(err) } };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Standard correction prompt. Kept short to minimize latency. The
 * caller wraps this in their LLM SDK call. All semantic correctors in
 * this repo (Ollama / OpenAI / Anthropic wrappers) use this verbatim.
 *
 * If `agentContext.lastUtterance` is provided, the prompt tells the
 * model to prefer phonetically similar words from that utterance —
 * useful for names, code identifiers, and in-topic vocabulary that
 * STT is likely to have mis-heard.
 */
export function buildCorrectionPrompt(noisyText: string, agentContext?: AgentContext): string {
  const lines = [
    'Fix transcription errors in the following text. Rules:',
    '- Preserve meaning exactly. Do NOT add new information.',
    '- Remove filler words ("uh", "um", "like", "you know").',
    '- Fix obvious homophone errors (to/too/two, their/there).',
    '- Fix word-level grammar only if obviously wrong.',
    '- Do NOT rephrase, summarize, or expand.',
    '- Return ONLY the corrected text. No preamble, no quotes.',
  ];
  if (agentContext?.lastUtterance) {
    lines.push(
      '- If a word looks garbled, prefer a phonetically similar name or',
      '  identifier from the assistant\'s last turn below. Preserve the',
      '  assistant\'s original casing (e.g. "Seattle", "useState").',
      '- If the user\'s reply is clearly a new topic, ignore the assistant',
      '  turn for vocabulary and correct the text on its own merits.',
      '',
      `Assistant's last turn: ${JSON.stringify(agentContext.lastUtterance)}`,
    );
  }
  lines.push('', `Input: ${noisyText}`, 'Corrected:');
  return lines.join('\n');
}
