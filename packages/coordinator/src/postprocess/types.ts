/**
 * STT post-processing pipeline: cleans and corrects raw transcripts
 * between the STT engine and the dialogue pipeline.
 *
 * Stages are pluggable. Each stage decides per-call whether to run,
 * and may escalate cost (rules < phrase match < LLM) depending on
 * what the previous stages produced and the caller-supplied confidence.
 */

/**
 * Recent agent side of the conversation, fed into the pipeline so
 * stages can bias correction toward in-context vocabulary (names,
 * code identifiers, product terms) that are likely to be mis-heard.
 *
 * Populated by the server after each completed turn.
 */
export type AgentContext = {
  /** Raw text the agent said in the previous turn. */
  lastUtterance?: string;
  /**
   * If the agent's last turn ended with a question, a coarse
   * classification so we can detect reply-shape mismatch (yes-no
   * question answered with an unrelated noun = topic change).
   */
  pendingQuestion?: {
    kind: 'yes-no' | 'choice' | 'open';
    options?: string[];
  };
};

export type PostProcessContext = {
  /** Current best transcript text (may have been edited by prior stages). */
  text: string;
  /** STT engine confidence 0..1, if available. Drives routing heuristics. */
  confidence?: number;
  /** Agent side of the conversation for context-aware correction. */
  agentContext?: AgentContext;
  /** Upstream metadata the stages may want (e.g. dialogue phase). */
  metadata?: Record<string, unknown>;
};

export type PostProcessStepResult = {
  /** Text after this stage ran. */
  text: string;
  /** True if text changed — used to skip no-op stages in the trace. */
  changed: boolean;
  /** Stage-specific debugging info (match score, edit count, etc.). */
  info?: Record<string, unknown>;
};

/** One stage of the pipeline. Called in order; each may consult and
 *  mutate the running text. Keep per-stage work bounded — the whole
 *  pipeline runs on every user turn. */
export interface PostProcessStage {
  readonly name: string;
  shouldRun(ctx: PostProcessContext): boolean;
  run(ctx: PostProcessContext): Promise<PostProcessStepResult> | PostProcessStepResult;
}

export type PostProcessResult = {
  /** Final corrected text. */
  text: string;
  /** Untouched input, for debugging / logging. */
  original: string;
  /** Names of stages that actually produced a change. */
  stagesApplied: string[];
  /** Per-stage before/after for tracing. */
  history: Array<{ stage: string; before: string; after: string; info?: Record<string, unknown> }>;
  /** Wall-clock ms for the entire pipeline. */
  latencyMs: number;
};
