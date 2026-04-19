# STT Post-Processing Pipeline

Cleans and corrects raw STT transcripts between the speech recognizer
and the dialogue pipeline. Designed for voice AI apps where the base
STT model can't be retrained, but you want measurably better accuracy —
especially for noisy input, accents, or mixed-language speech.

## Architecture

```
                 ┌──────────────────────────────────────────────────────────────────────┐
                 │                        PostProcessPipeline                           │
                 │                                                                      │
 raw STT text ──▶│  ┌───────┐    ┌────────────────┐    ┌────────────┐    ┌───────────┐  │──▶ clean text
                 │  │ Rules │───▶│ 2. ContextBias │───▶│ 3. Phrases │───▶│ 4. Semantic│ │
                 │  └───────┘    └────────────────┘    └────────────┘    └───────────┘  │
                 │   sync, <1ms  sync, <1ms             sync, <5ms       async, 100-2s  │
                 │   always on   if agent-ctx & on-topic always on       conditional    │
                 └──────────────────────────────────────────────────────────────────────┘
                             │                    ▲                           │
                     each stage decides           │                    every stage that
                     per-call via shouldRun()     │                   fires is logged
                                                  │                    in result history
                                       agent context (previous
                                        assistant utterance +
                                       pending-question shape)
```

**Stage contract** (`PostProcessStage` in [types.ts](../packages/coordinator/src/postprocess/types.ts)):

```ts
interface PostProcessStage {
  readonly name: string;
  shouldRun(ctx: PostProcessContext): boolean;
  run(ctx: PostProcessContext): Promise<PostProcessStepResult> | PostProcessStepResult;
}
```

Each stage receives the **running text** (mutated by prior stages) plus the caller-supplied `confidence` and `metadata`. Stages are pure and composable — swap, reorder, or add your own.

## Stages

### 1. `RuleStage` — deterministic cleanup

Zero-LLM, synchronous, microsecond cost. Always runs.

- **Filler removal** — regex over a configurable word list (`uh`, `um`, `like`, `you know`, …). Word-boundary aware, preserves leading delimiters so words don't fuse.
- **Repeated-word collapse** — `"the the the cat"` → `"the cat"`. Case-insensitive.
- **Phonetic fixes** — a `{ wrong: right }` map for common STT artifacts. Ship with `gonna → going to`, `wanna → want to`, extend per-domain.
- **Whitespace/punctuation normalization** — trims doubles, fixes space-before-comma, etc.

### 2. `ContextBiasStage` — snap to vocabulary from the agent's last turn

Bias the user's transcript toward **names, code identifiers, and rare words** that the assistant just used. Canonical case is preserved: `"see tell"` → `"Seattle"`, `"use state"` → `"useState"`. Designed for the common STT-failure mode where a phonetically unambiguous word gets mis-segmented into common-word salad.

Algorithm:
1. `extractSalientTokens(agentContext.lastUtterance)` — pulls out backticked tokens (weight 3.0), code identifiers (2.5), proper nouns (2.0), and rare content words (1.0). Stopwords and ultra-common vocab are excluded.
2. For each 1- or 2-token window in the user's transcript, concatenate (case-fold) and compute Soundex.
3. If the Soundex matches a salient token AND edit distance is within `maxRelativeDistance × candLength`, replace the window with the agent's surface form.

**Topic-change gate** — the stage self-skips when `detectTopicChange(userText, agentContext)` fires:
- Explicit markers (`"by the way"`, `"actually"`, `"never mind"`, `"wait"`, `"also"`, `"different question"`, …) → `explicit-marker`.
- Yes-no question answered without any yes-no token → `yes-no-mismatch`.
- Choice question answered without any listed option → `choice-mismatch`.

Without these guards, context bias would pull a genuine topic change ("pizza") toward the agent's recent vocabulary ("flight to Seattle"). The gate keeps the stage out of the way when the user's signal is clear.

### 3. `PhraseMatcherStage` — fuzzy snap to canonical phrases

O(N·L) over a small list of known phrases (commands, names, jargon). Uses a combined metric:

```
score = 0.6 × normalized-Levenshtein  +  0.4 × token Jaccard
```

Both in `[0, 1]`. Default threshold `0.78`. Above threshold → snap; below → pass through.

Works well for **≤ a few hundred phrases**. For larger catalogs, swap in an embedding ANN index behind the same `PostProcessStage` interface.

### 4. `SemanticCorrectionStage` — conditional LLM correction

Only runs when **confidence is low** OR **structural ambiguity markers** are detected (residual fillers the rule stage missed, duplicated words, runs of very short tokens). Never blocks a turn — 2.5s default timeout, silent fallback to the previous stage's output on error.

- **Prompt contract** ([semantic.ts :: `buildCorrectionPrompt`](../packages/coordinator/src/postprocess/semantic.ts)): preserve meaning, fix homophones, remove fillers, output corrected text only.
- **Hallucination guardrail** — reject corrections where output length is >3× or <10% of input length.
- **Pluggable corrector** — pass any `(text, { signal?, agentContext? }) => Promise<string>`. Ships with `makeOllamaCorrector()` (uses the same Ollama endpoint as the SLM router, `keep_alive: 30m`). The optional `agentContext` carries the assistant's previous utterance so the LLM can bias toward in-context names and identifiers.

## Routing logic

```
text → Rules (always)
     → ContextBias (only if agentContext present AND topic hasn't changed)
     → Phrases (always, but skipped for text > 12 words)
     → Semantic (only if confidence < 0.6 OR ambiguity markers;
                 agentContext forwarded to the LLM iff topic hasn't changed)
```

## Correction feedback loop

Users can teach the pipeline a correction at runtime via `POST /correction { original, corrected }`. [corrections.ts](../packages/coordinator/src/postprocess/corrections.ts) holds a `CorrectionStore` that:

- Persists to `.oasis-corrections.json` (override via `OASIS_CORRECTIONS_FILE`).
- Classifies each correction via `analyzeDiff`:
  - Single-token substitution with surrounding tokens identical → adds a **word rule** (`RuleStage.phoneticFixes`) that generalizes to any future phrasing of the same mis-hearing.
  - Any multi-word correction also indexes the corrected sentence as a **canonical phrase** (`PhraseMatcherStage.phrases`) so fuzzy matching can snap to it later.
- Calls back into the server with `onChange` so the live pipeline rebuilds without a restart.
- Reloads on startup so the learned vocabulary survives restarts.

`GET /corrections` returns the current `{ wordRules, phrases, history }` for inspection.

If you have per-word STT confidence, pass it via `ctx.confidence`; lower confidence → more aggressive escalation. If you don't, the semantic stage still fires on residual ambiguity.

## Usage

```ts
import {
  PostProcessPipeline,
  RuleStage,
  PhraseMatcherStage,
  SemanticCorrectionStage,
  makeOllamaCorrector,
} from '@oasis-echo/coordinator';

const pipeline = new PostProcessPipeline([
  new RuleStage({
    phoneticFixes: { gonna: 'going to', lemme: 'let me' },
  }),
  new PhraseMatcherStage({
    phrases: ['send an email', 'schedule a meeting', 'play some music'],
    similarityThreshold: 0.78,
  }),
  new SemanticCorrectionStage({
    correct: makeOllamaCorrector({ model: 'gemma4:e2b' }),
    minConfidenceToRun: 0.6,
    timeoutMs: 2500,
  }),
]);

const result = await pipeline.process({
  text: 'uh um so gonna send a email',
  confidence: 0.55,
});
// result.text          → "send an email"
// result.original      → "uh um so gonna send a email"
// result.stagesApplied → ["rules", "phrases"]
// result.history       → [{stage, before, after, info}, …]
// result.latencyMs     → 4
```

## Sample input/output

| Input (raw STT) | Output | Stages that fired |
|---|---|---|
| `uh um like how are you doing today` | `how are you doing today` | rules |
| `turn turn on the the lights` | `turn on the lights` | rules, phrases |
| `I'm gonna schedule the meeting` | `schedule a meeting` | rules, phrases |
| `sent an email` | `send an email` | phrases |
| `how is the weather today` | `how is the weather today` | *(unchanged — nothing close enough to snap)* |
| `uh play some música por favor` *(mixed-lang)* | `play some música por favor` | rules |

## Performance

Measured on M-series Mac, gemma4:e2b for semantic stage:

| Stage | Typical cost | Worst case |
|---|---|---|
| Rules | <0.5ms | 2ms |
| Phrases (50 canonical) | 0.5–2ms | 8ms |
| Phrases (500 canonical) | 5–20ms | 40ms |
| Semantic (Ollama gemma4:e2b) | 400–800ms | 2500ms (timeout) |

For **real-time** use: keep the phrase catalog ≤ a few hundred entries, and gate semantic on actual low-confidence signals so it fires on <10% of turns.

## Extensibility

**Custom stage** — implement `PostProcessStage`:

```ts
class DomainGlossaryStage implements PostProcessStage {
  readonly name = 'domain-glossary';
  shouldRun(ctx: PostProcessContext) {
    return /\b(widget|foo|bar)\b/i.test(ctx.text);
  }
  run(ctx: PostProcessContext): PostProcessStepResult {
    const text = ctx.text
      .replace(/\bwidget\b/gi, 'Widget™')
      .replace(/\bfoo\b/gi, 'Foo');
    return { text, changed: text !== ctx.text };
  }
}
```

Drop it into `new PostProcessPipeline([..., new DomainGlossaryStage()])`.

**Different LLM provider** — pass any function matching `SemanticCorrectorFn`:

```ts
const correct: SemanticCorrectorFn = async (text, { signal, agentContext } = {}) => {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: buildCorrectionPrompt(text, agentContext) }],
    }),
    ...(signal ? { signal } : {}),
  });
  const data = await res.json();
  return data.choices[0].message.content;
};
```

**Custom phrase list** — set `OASIS_STT_PHRASES_FILE` to a plain-text file, one phrase per line (`#` comments allowed). The server loads it at startup.

## Integration with the dialogue pipeline

In [server.ts](../packages/app/src/server.ts), the `/turn` handler runs post-processing before `pipeline.handleTurn()`:

```ts
const pp = await postprocess.process({ text });
if (pp.stagesApplied.length > 0) {
  logger.info('stt.postprocess', { original: pp.original, final: pp.text, stages: pp.stagesApplied });
  hub.broadcast('stt.postprocess', { turnId, ...pp });
}
await pipeline.handleTurn(pp.text, { turnId });
```

The cleaned text goes to routing and reasoning. The `stt.postprocess` SSE event exposes before/after so the UI can visualize what each stage did.

## Tradeoffs

- **Latency vs accuracy**: semantic stage adds 400–2500ms. Only fire it when worth it — low STT confidence or structural ambiguity.
- **Phrase catalog size**: matching cost is O(N·L); at ~500 phrases, switch to an embedding ANN index.
- **Over-correction**: the LLM can hallucinate new meaning. The length-drift guardrail catches the worst cases; tighter guardrails (semantic-similarity floor against the original) can be layered on.
- **Language mixing**: phrase matcher is token-based — mixed-language inputs fail to snap, but the rule stage still cleans them. The semantic stage handles mixed-language correction when the backend model supports it.
