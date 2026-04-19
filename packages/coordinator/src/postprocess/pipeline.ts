import type {
  PostProcessContext,
  PostProcessResult,
  PostProcessStage,
} from './types.js';

/**
 * Orchestrator: runs stages in order, forwarding each one's output
 * as the next one's input. Stages decide per-call whether to run via
 * their own `shouldRun(ctx)`. The pipeline adds:
 *
 *   - full before/after history for every stage that fired
 *   - total wall-clock latency
 *   - a final guardrail that reverts to the original text if all
 *     stages combined produced only whitespace (defensive — if
 *     something goes sideways, we'd rather keep the raw text than
 *     ship an empty string to the router)
 */
export class PostProcessPipeline {
  constructor(private readonly stages: readonly PostProcessStage[]) {}

  async process(input: PostProcessContext): Promise<PostProcessResult> {
    const startedAt = Date.now();
    const original = input.text;
    let text = input.text;
    const stagesApplied: string[] = [];
    const history: PostProcessResult['history'] = [];

    for (const stage of this.stages) {
      const ctx: PostProcessContext = {
        ...input,
        text,
      };
      if (!stage.shouldRun(ctx)) continue;
      const result = await stage.run(ctx);
      if (!result.changed) continue;
      history.push({
        stage: stage.name,
        before: text,
        after: result.text,
        ...(result.info ? { info: result.info } : {}),
      });
      text = result.text;
      stagesApplied.push(stage.name);
    }

    // Final guardrail against pathological empty output.
    if (text.trim().length === 0) text = original;

    return {
      text,
      original,
      stagesApplied,
      history,
      latencyMs: Date.now() - startedAt,
    };
  }
}
