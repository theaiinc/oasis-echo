import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadDotenv } from './env.js';
import {
  ContextBiasStage,
  CorrectionStore,
  EmotionAdaptiveTts,
  FunasrStreamingStt,
  KokoroTts,
  OllamaRouter,
  PassthroughTts,
  PhraseMatcherStage,
  PostProcessPipeline,
  RuleStage,
  SemanticCorrectionStage,
  SpeculationManager,
  ThreeTierRouter,
  WhisperStreamingStt,
  alwaysEscalate,
  classifyQuestion,
  detectEmotionFromText,
  makeOllamaCorrector,
  normalizeSerLabel,
  type AdaptedReply,
  type AgentContext,
  type Emotion,
  type EmotionInput,
  type Router,
  type StreamingTts,
  type Strategy,
} from '@oasis-echo/coordinator';
import { Pipeline } from '@oasis-echo/orchestrator';
import {
  AnthropicReasoner,
  McpRegistry,
  OllamaReasoner,
  OpenAIReasoner,
  ToolRegistry,
  echoTool,
  timeTool,
  type Reasoner,
} from '@oasis-echo/reasoning';
import { createLogger, Metrics, Tracer } from '@oasis-echo/telemetry';
import { loadConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Short "still listening" acknowledgements played while the user is
// mid-utterance. Pre-synthesized through Kokoro at startup so the
// client can trigger them instantly and play at Web-Audio volume.
//
// Avoid letter-only onomatopoeia like "mhm" or "Mm" — Kokoro's phonemizer
// reads those as letter names ("em-ech-em"). Stick to tokens with a vowel
// spelling the phonemizer can actually sound out.
const BACKCHANNEL_PHRASES = [
  'uh huh',
  'yeah',
  'right',
  'I see',
  'got it',
  'go on',
  'okay',
];

type BackchannelCacheEntry = { audio: string; sampleRate: number };
const backchannelCache = new Map<string, BackchannelCacheEntry>();

async function primeBackchannelCache(kokoro: KokoroTts): Promise<void> {
  for (const phrase of BACKCHANNEL_PHRASES) {
    for await (const chunk of kokoro.synthesize(phrase)) {
      if (!chunk.pcm) continue;
      const bytes = new Uint8Array(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength);
      backchannelCache.set(phrase, {
        audio: Buffer.from(bytes).toString('base64'),
        sampleRate: chunk.sampleRate,
      });
      break; // only one chunk per short phrase
    }
  }
}
// Load .env from the repo root so `ANTHROPIC_API_KEY=…` in that file
// switches the reasoner on without any export ceremony.
loadDotenv(join(__dirname, '..', '..', '..', '.env'));
loadDotenv(join(process.cwd(), '.env'));

/** `PORT` unset → OS picks a free port (no collisions). Set `PORT=3000` to pin. */
function resolveListenPort(): number {
  const raw = process.env['PORT']?.trim();
  if (raw === undefined || raw === '') return 0;
  if (raw.toLowerCase() === 'auto') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return 0;
  return Math.trunc(n);
}

function resolveListenHost(): string {
  return process.env['OASIS_LISTEN_HOST']?.trim() || '127.0.0.1';
}

function persistListenPort(port: number): void {
  try {
    const dir = join(homedir(), '.oasis-echo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'listen-port'), `${port}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

const requestedListenPort = resolveListenPort();
const requestedListenHost = resolveListenHost();
const HTML = readFileSync(join(__dirname, '..', 'src', 'index.html'), 'utf8');

type SseClient = {
  id: number;
  res: ServerResponse;
};

class Hub {
  private nextId = 1;
  private readonly clients = new Map<number, SseClient>();

  subscribe(req: IncomingMessage, res: ServerResponse): number {
    const id = this.nextId++;
    // Keep the socket open indefinitely; default Node timeouts will kill
    // idle SSE connections otherwise, which the browser reports as
    // "disconnected — reconnecting…".
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Initial comment flushes headers immediately; browser fires `open`.
    res.write(`: connected id=${id}\n\n`);
    const client = { id, res };
    this.clients.set(id, client);
    // Heartbeat every 15s keeps proxies and the browser happy.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        this.clients.delete(id);
      }
    }, 15_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(id);
    });
    return id;
  }

  broadcast(type: string, payload: unknown): void {
    let line: string;
    try {
      line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    } catch (err) {
      line = `event: error\ndata: ${JSON.stringify({ source: 'serialize', error: String(err), atMs: Date.now() })}\n\n`;
    }
    for (const c of this.clients.values()) {
      try {
        c.res.write(line);
      } catch {
        this.clients.delete(c.id);
      }
    }
  }
}

/**
 * Compose the reasoner's system-prompt suffix that enumerates MCP
 * tools plus the emission format the Ollama reasoner parses out of
 * the model's stream. The instructions here are intentionally written
 * so even a non-function-calling model (Gemma, vanilla Llama) can
 * comply — it's plain text pattern, no tools-API required.
 *
 * Only surfaces tools likely to be useful inside a voice turn
 * (web_search, browse_url, memory_*, artifact_*) — the 70-ish
 * infrastructure tools (workflow_*, trigger_*, cu_*, agent_*) would
 * blow out the prompt and confuse short replies with long catalogues.
 */
/**
 * Keyword sniff for utterances whose correct answer depends on live
 * data — weather, news, prices, sports scores, schedules, or any
 * "latest/current/today" phrasing. When this returns true the server
 * skips the speculation/smalltalk short-circuits and forces the turn
 * through `handleTurn`, where the reasoner has tools and fillers are
 * played while we wait on the tool call.
 *
 * Tuned conservatively — false positives just add tool latency, false
 * negatives hallucinate. Update this list freely as new query shapes
 * land in telemetry.
 */
function needsFreshData(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  const patterns: RegExp[] = [
    /\b(?:weather|temperature|forecast|rain(?:ing)?|snow(?:ing)?|humidity)\b/,
    /\b(?:news|headline|breaking|update[sd]?\s+on)\b/,
    /\b(?:price|stock|market|exchange rate|btc|bitcoin|crypto)\b/,
    /\b(?:score|match|game|result)\b.{0,30}\b(?:today|tonight|yesterday|live)\b/,
    /\b(?:latest|current|today'?s|tonight'?s|this (?:week|month|morning|afternoon|evening))\b/,
    /\b(?:flight|train|bus|schedule|arriv(?:e|al)|depart(?:ure)?)\b/,
    /\b(?:who (?:won|is winning|scored)|what happened)\b/,
    /\bnow\s*$/,  // ends with the word "now" — often a time-sensitive Q
  ];
  return patterns.some((re) => re.test(t));
}

function buildSystemPromptSuffix(mcp: McpRegistry): string | undefined {
  const connected = mcp.describe();
  if (connected.length === 0) return undefined;

  const VOICE_RELEVANT =
    /(?:web_search|browse_url|memory_query|memory_list_rules|artifact_search|artifact_get|artifact_summarize|oasis_ask|code_search_symbols)$/;
  type Picked = { qualifiedName: string; description: string | undefined; schema: unknown };
  const picks: Picked[] = [];
  for (const server of connected) {
    for (const toolName of server.tools) {
      if (!VOICE_RELEVANT.test(toolName)) continue;
      const def = mcp.getToolDefinition(toolName);
      picks.push({
        qualifiedName: toolName,
        description: def?.description,
        schema: def?.input_schema,
      });
    }
  }
  if (picks.length === 0) return undefined;

  const lines: string[] = [
    'TOOLS AVAILABLE:',
    'You have live tools for real-time information. PREFER them over your own memory any',
    'time the answer could be time-sensitive, factual, or user-specific.',
    '',
    'WHEN TO CALL A TOOL (default to YES unless the answer is a stable, universal fact):',
    '  - News, weather, prices, schedules, sports, scores, releases → web_search.',
    '  - Any "latest", "current", "today", "this week/month/year" phrasing → web_search.',
    '  - Specific companies, people, products, projects, policies → web_search.',
    '  - Reading a page the user mentions → browse_url.',
    '  - The user\'s own notes / artifacts / memory → the corresponding *_search/*_get tool.',
    '',
    'DO NOT answer from memory and then offer to "check" or "verify" — if a tool can check,',
    'CALL IT NOW and answer from the result. Saying "check the official website" is a bug.',
    '',
    'Use the tools via the standard function-calling protocol. Do NOT describe the call in',
    'prose or emit angle-bracket tags — just call the function. After the result arrives,',
    'speak a natural 1-3 sentence reply grounded in it; do not chain another tool call.',
    '',
    'TOOLS:',
  ];
  for (const p of picks) {
    const argsHint = summarizeSchemaForPrompt(p.schema);
    const desc = p.description ? p.description.replace(/\s+/g, ' ').slice(0, 160) : '';
    lines.push(`- ${p.qualifiedName}${argsHint} — ${desc}`);
  }
  return lines.join('\n');
}

/**
 * Produces a compact `{q:str,limit?:int}` argument hint for the prompt
 * from a JSON Schema. Keeps the model focused on the field names it's
 * allowed to pass without dumping the full schema JSON into the prompt.
 */
function summarizeSchemaForPrompt(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '';
  const s = schema as { properties?: Record<string, unknown>; required?: string[] };
  const props = s.properties;
  if (!props || typeof props !== 'object') return '';
  const required = new Set(s.required ?? []);
  const entries: string[] = [];
  for (const [k, raw] of Object.entries(props)) {
    const prop = raw as { type?: string | string[]; enum?: unknown };
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    const t = (typeof type === 'string' ? type : 'any').replace(/^integer$/, 'int');
    const optional = required.has(k) ? '' : '?';
    entries.push(`${k}${optional}:${t}`);
  }
  if (entries.length === 0) return '';
  return `  { ${entries.join(', ')} }`;
}

type MeetingSegment = { elapsedSec: number; speaker: string; text: string };

type MeetingRecord = {
  id: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  transcript: MeetingSegment[];
  notes: string;
  userNotes: string;
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel, bindings: { session: cfg.sessionId } });
  const metrics = new Metrics();
  const tools = new ToolRegistry();
  tools.register(timeTool());
  tools.register(echoTool());

  // ── Home Assistant native tools (fallback when HA MCP server is unavailable) ──
  const haUrl = process.env['HA_URL'];
  const haToken = process.env['HA_TOKEN'];
  if (haUrl) {
    const baseUrl = haUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${haToken ?? ''}`,
    };

    tools.register({
      name: 'ha_turn_on',
      description: 'Turns on a Home Assistant device/entity.',
      input_schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Entity ID of the device to turn on (e.g. light.living_room)' },
          brightness: { type: 'number', description: 'Optional brightness level (0-255)' },
        },
        required: ['entity_id'],
      },
      handler: async (input: { entity_id: string; brightness?: number }) => {
        if (!haToken) return { error: 'HA_TOKEN not configured \u2014 set HA_TOKEN in your environment' };
        const body: Record<string, unknown> = { entity_id: input.entity_id };
        if (input.brightness !== undefined) body.brightness = input.brightness;
        const res = await fetch(`${baseUrl}/api/services/homeassistant/turn_on`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) return { error: `HA API error: ${res.status} ${res.statusText}` };
        return { result: await res.json() };
      },
    });

    tools.register({
      name: 'ha_turn_off',
      description: 'Turns off a Home Assistant device/entity.',
      input_schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Entity ID of the device to turn off (e.g. light.living_room)' },
        },
        required: ['entity_id'],
      },
      handler: async (input: { entity_id: string }) => {
        if (!haToken) return { error: 'HA_TOKEN not configured \u2014 set HA_TOKEN in your environment' };
        const res = await fetch(`${baseUrl}/api/services/homeassistant/turn_off`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ entity_id: input.entity_id }),
        });
        if (!res.ok) return { error: `HA API error: ${res.status} ${res.statusText}` };
        return { result: await res.json() };
      },
    });

    tools.register({
      name: 'ha_get_state',
      description: 'Gets the current state of a Home Assistant entity.',
      input_schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Entity ID to query (e.g. light.living_room)' },
        },
        required: ['entity_id'],
      },
      handler: async (input: { entity_id: string }) => {
        if (!haToken) return { error: 'HA_TOKEN not configured \u2014 set HA_TOKEN in your environment' };
        const res = await fetch(`${baseUrl}/api/states/${input.entity_id}`, {
          headers,
        });
        if (!res.ok) return { error: `HA API error: ${res.status} ${res.statusText}` };
        return { result: await res.json() };
      },
    });

    tools.register({
      name: 'ha_list_entities',
      description: 'Lists available Home Assistant entities, optionally filtered by area.',
      input_schema: {
        type: 'object',
        properties: {
          area_id: { type: 'string', description: 'Optional area ID to filter entities by' },
        },
        required: [],
      },
      handler: async (input: { area_id?: string }) => {
        if (!haToken) return { error: 'HA_TOKEN not configured \u2014 set HA_TOKEN in your environment' };
        const res = await fetch(`${baseUrl}/api/states`, { headers });
        if (!res.ok) return { error: `HA API error: ${res.status} ${res.statusText}` };
        const states = (await res.json()) as Array<{ entity_id: string; area_id?: string }>;
        const filtered = input.area_id
          ? states.filter((s) => s.area_id === input.area_id)
          : states;
        return { entities: filtered.map((s) => ({ entity_id: s.entity_id, area_id: s.area_id })) };
      },
    });
    logger.info('home assistant native tools registered', { haUrl: baseUrl, tools: 4 });
  }

  // Connect to every MCP server declared in `.mcp.json` (same format
  // Claude Code / Claude Desktop use). Discovered tools are namespaced
  // `<serverKey>__<toolName>` and registered alongside the built-ins
  // so the reasoner's model sees them via the normal tools array.
  const mcp = new McpRegistry({ logger });
  const mcpTools = await mcp.loadFromFile().catch((err) => {
    logger.warn('mcp registry failed to load', { error: String(err) });
    return [];
  });
  for (const t of mcpTools) {
    try { tools.register(t); }
    catch (err) { logger.warn('mcp tool register failed', { name: t.name, error: String(err) }); }
  }
  if (mcpTools.length > 0) {
    logger.info('mcp tools registered', {
      count: mcpTools.length,
      servers: mcp.describe(),
    });
  }

  // Build a system-prompt suffix that enumerates connected MCP tools so
  // the reasoner model is explicitly told what it has access to.
  // `AnthropicReasoner` already carries tool definitions in its API
  // request, but a brief system-prompt hint meaningfully improves tool
  // selection on smaller Claude models.
  const systemPromptSuffix = buildSystemPromptSuffix(mcp);

  let reasoner: Reasoner;
  if (cfg.backend === 'anthropic') {
    reasoner = new AnthropicReasoner({
      logger,
      tools,
      model: cfg.model,
      ...(systemPromptSuffix ? { systemPromptSuffix } : {}),
    });
    logger.info('reasoner', { backend: 'anthropic', model: cfg.model });
  } else if (cfg.backend === 'ollama') {
    reasoner = new OllamaReasoner({
      logger,
      model: cfg.model,
      baseUrl: cfg.ollamaBaseUrl,
      tools,
      ...(systemPromptSuffix ? { systemPromptSuffix } : {}),
    });
    logger.info('reasoner', { backend: 'ollama', model: cfg.model, baseUrl: cfg.ollamaBaseUrl });
  } else {
    reasoner = new OpenAIReasoner({
      logger,
      model: cfg.model,
      baseUrl: cfg.openaiBaseUrl,
      timeoutMs: cfg.reasonerTimeoutMs,
    });
    logger.info('reasoner', { backend: 'openai', model: cfg.model, baseUrl: cfg.openaiBaseUrl });
  }

  // Three-tier router: Arch-Router-1.5B classifies intent in <500ms,
  // then either SLM replies (smalltalk) or escalates to reasoner.
  const router: Router = new ThreeTierRouter({
    archBaseUrl: cfg.archBaseUrl,
    archModel: cfg.archModel,
    slmBaseUrl: cfg.routerBaseUrl,
    slmModel: cfg.routerModel,
    logger,
    fallback: alwaysEscalate,
  });
  void (router as ThreeTierRouter).warm();
  logger.info('router', {
    backend: 'three-tier',
    classifier: `arch-router@${cfg.archBaseUrl}`,
    slmModel: cfg.routerModel,
    slmBaseUrl: cfg.routerBaseUrl,
  });

  let tts: StreamingTts;
  let kokoroInstance: KokoroTts | null = null;
  let kokoroWarmResolve: (() => void) | null = null;
  const kokoroWarmed = new Promise<void>((resolve) => { kokoroWarmResolve = resolve; });

  if (cfg.ttsBackend === 'kokoro') {
    kokoroInstance = new KokoroTts({
      logger,
      voice: cfg.kokoroVoice,
      dtype: cfg.kokoroDtype,
    });
    tts = kokoroInstance;
    // Warm the model in the background so the first turn isn't a
    // 10-second cold start. While loading, the passthrough path below
    // kicks in so the pipeline still functions.
    void kokoroInstance.warm().then(async () => {
      // After warm-up, synthesize each backchannel phrase once and
      // cache the PCM so the client can fetch them instantly at full
      // volume (speechSynthesis output is typically much quieter than
      // Web Audio, which was making the backchannel barely audible).
      await primeBackchannelCache(kokoroInstance!);
      logger.info('backchannel cache primed', { count: backchannelCache.size });
      kokoroWarmResolve?.();
      kokoroWarmResolve = null;
    }).catch((err) => {
      logger.error('kokoro warm failed', { error: String(err) });
      kokoroWarmResolve?.();
      kokoroWarmResolve = null;
    });
  } else {
    // Text-only passthrough — the browser client voices each chunk
    // via speechSynthesis on receipt.
    tts = new PassthroughTts();
  }

  const pipeline = new Pipeline({
    sessionId: cfg.sessionId,
    router,
    reasoner,
    tts,
    logger,
    metrics,
    tracer: new Tracer(),
  });

  // Speculative execution: run router + reasoner on stable partials
  // while the user is still speaking, so first TTS chunk can fire
  // within tens of milliseconds of the commit when the partial matches.
  const speculation = new SpeculationManager({
    router,
    reasoner,
    getState: () => pipeline.state.snapshot(),
    logger,
  });

  // STT post-processing pipeline: cleans the raw transcript before it
  // hits the dialogue pipeline. Three stages in order:
  //   1. rules   — strip fillers, collapse repeats, phonetic fixes
  //   2. phrases — snap noisy text to known canonical phrases
  //   3. semantic — LLM-based correction, conditional on low confidence
  //                 or ambiguity markers
  //
  // The pipeline is REBUILT on every user correction: when POST
  // /correction arrives, the CorrectionStore updates its word-rule
  // and phrase buckets, and we swap in a fresh pipeline so future
  // turns pick up the new data without restarting the server.
  const correctionsPath =
    process.env['OASIS_CORRECTIONS_FILE'] ??
    join(process.cwd(), '.oasis-corrections.json');
  const correctionStore = new CorrectionStore(correctionsPath, () => {
    postprocess = buildPostProcess();
    logger.info('postprocess rebuilt', {
      wordRules: Object.keys(correctionStore.wordRules()).length,
      phrases: correctionStore.phrases().length,
    });
  });

  function buildPostProcess(): PostProcessPipeline {
    return new PostProcessPipeline([
      new RuleStage({
        phoneticFixes: {
          // Baseline common-speech normalizations.
          gonna: 'going to',
          wanna: 'want to',
          gotta: 'got to',
          cuz: 'because',
          lemme: 'let me',
          gimme: 'give me',
          // User-learned rules from past /correction calls.
          ...correctionStore.wordRules(),
        },
      }),
      // Context-bias runs AFTER rules (so it sees cleaned text) but
      // BEFORE phrase matching (a successful context snap can feed a
      // cleaner phrase match). Skipped automatically when no agent
      // context exists or the topic-change gate fires.
      new ContextBiasStage({}),
      new PhraseMatcherStage({
        // Seed list + anything the user has taught us.
        phrases: [...loadPhraseList(), ...correctionStore.phrases()],
        similarityThreshold: 0.78,
      }),
      ...(cfg.backend === 'ollama'
        ? [
            new SemanticCorrectionStage({
              correct: makeOllamaCorrector({
                baseUrl: cfg.ollamaBaseUrl,
                model: cfg.routerModel,
                logger,
              }),
              minConfidenceToRun: 0.6,
              timeoutMs: 2500,
            }),
          ]
        : []),
    ]);
  }

  await correctionStore.load();
  let postprocess = buildPostProcess();
  logger.info('corrections loaded', {
    path: correctionsPath,
    wordRules: Object.keys(correctionStore.wordRules()).length,
    phrases: correctionStore.phrases().length,
  });

  const hub = new Hub();

  // Rolling agent context, fed into the STT post-processor on every
  // subsequent user turn. Updated on turn.complete so the NEXT user
  // utterance sees the assistant's latest reply.
  let agentContext: AgentContext = {};

  // Emotion-Adaptive TTS. Client-side SER classifier attaches
  // `{ emotion, confidence }` to POST /turn; we resolve a strategy,
  // compute TTS directives, broadcast them on an `emotion.directives`
  // event, and the client applies them to incoming tts.chunk events.
  const emotionAdapter = new EmotionAdaptiveTts();
  const emotionHistory: Emotion[] = [];
  const EMOTION_HISTORY_MAX = 6;
  // Active directives per in-flight turn, so chunked tts.chunk events
  // can be decorated with the same emotion envelope for the whole turn.
  const activeDirectives = new Map<string, AdaptedReply>();

  // Log high-signal turn events to the server stdout so the live log
  // is actually useful (not just GET /state polling).
  pipeline.bus.on('route.decision', (e) => {
    logger.info('route', { turnId: e.turnId, kind: e.decision.kind, intent: e.decision.intent });
  });
  pipeline.bus.on('turn.complete', (e) => {
    const agentText = e.turn.agentText ?? '';
    if (agentText.trim()) {
      const pendingQuestion = classifyQuestion(agentText);
      agentContext = {
        lastUtterance: agentText,
        ...(pendingQuestion ? { pendingQuestion } : {}),
      };
    }
    logger.info('turn', {
      id: e.turn.id,
      tier: e.turn.tier,
      intent: e.turn.intent,
      interrupted: e.turn.interrupted,
      userText: e.turn.userText.slice(0, 120),
      agentText: agentText.slice(0, 300),
      pendingQ: agentContext.pendingQuestion?.kind ?? 'none',
      latencyMs: (e.turn.endedAtMs ?? 0) - e.turn.startedAtMs,
    });
  });

  // Relay every pipeline event to connected SSE clients.
  pipeline.bus.onAny((event) => {
    if (event.type === 'tts.chunk') {
      const payload: Record<string, unknown> = {
        turnId: event.turnId,
        text: event.text,
        sampleRate: event.sampleRate,
        final: event.final,
        filler: event.filler === true,
        atMs: event.atMs,
      };
      if (event.pcm && event.pcm.length > 0) {
        // Real PCM — base64-encode the bytes so it survives JSON.
        const bytes = new Uint8Array(event.pcm.buffer, event.pcm.byteOffset, event.pcm.byteLength);
        payload['audio'] = Buffer.from(bytes).toString('base64');
      }
      hub.broadcast('tts.chunk', payload);
    } else if (event.type === 'audio.frame') {
      // skip — very noisy, not useful in the UI
    } else {
      // All other events serialize cleanly
      hub.broadcast(event.type, event);
    }
  });

  /**
   * Emit a single `stt.final` for the UI. Previously this function
   * replayed the text word-by-word with a 40ms sleep per word for a
   * "typing" effect; that added up to ~1s of blocking delay on long
   * utterances BEFORE the reasoner's pre-buffered reply could flow
   * through TTS. With `sendPartial` streaming every browser interim
   * during the utterance, the UI already has live transcript — the
   * animation is redundant.
   */
  function emitFinalTranscript(text: string, turnId: string): void {
    hub.broadcast('stt.final', { turnId, text: text.trim(), atMs: Date.now() });
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const reqStart = Date.now();
    res.on('finish', () => {
      process.stdout.write(
        `  ${req.method ?? 'GET'} ${url.pathname} → ${res.statusCode} (${Date.now() - reqStart}ms)\n`,
      );
    });

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      hub.subscribe(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          backend: cfg.backend,
          model: cfg.model,
          ...(cfg.backend === 'ollama' ? { baseUrl: cfg.ollamaBaseUrl } : {}),
          ...(cfg.backend === 'openai' ? { baseUrl: cfg.openaiBaseUrl } : {}),
          tts: {
            backend: cfg.ttsBackend,
            ...(cfg.ttsBackend === 'kokoro'
              ? {
                  voice: cfg.kokoroVoice,
                  dtype: cfg.kokoroDtype,
                  ready: kokoroInstance?.isReady ?? false,
                }
              : {}),
          },
          session: cfg.sessionId,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      const s = pipeline.state.snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          phase: s.phase,
          allowedIntents: s.allowedIntents,
          slots: s.slots,
          turns: s.turns.length,
          summary: s.summary,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/backchannel') {
      // Hand out a random pre-synthesized Kokoro clip. Empty payload
      // if the cache hasn't primed yet — client falls back to
      // speechSynthesis in that case.
      const phrases = [...backchannelCache.keys()];
      if (phrases.length === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: false }));
        return;
      }
      const phrase = phrases[Math.floor(Math.random() * phrases.length)]!;
      const entry = backchannelCache.get(phrase)!;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: true, text: phrase, ...entry }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics.snapshot()));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/services') {
      const bridgeHost = process.env['R1_HOST'] ?? '192.168.68.118';
      const result: {
        pipeline: { stage: string; status: 'ok' | 'warn' | 'error'; detail: string; format?: string }[];
        services: { name: string; status: 'ok' | 'error'; detail: string; latencyMs?: number }[];
      } = { pipeline: [], services: [] };

      // ── Audio pipeline (the chain) ──
      result.pipeline.push({
        stage: '1. TTS Engine',
        status: kokoroInstance?.isReady ? 'ok' : 'error',
        detail: kokoroInstance?.isReady
          ? `${cfg.kokoroVoice} (${cfg.kokoroDtype}) — ready`
          : 'NOT ready',
        format: '24 kHz / mono / 16-bit PCM',
      });

      // Oasis Echo SSE
      result.pipeline.push({
        stage: '2. Oasis Echo SSE',
        status: 'ok' as const,
        detail: `streaming tts.chunk events to r1-bridge`,
        format: '24 kHz / mono / 16-bit PCM (base64)',
      });

      // r1-bridge connectivity
      let bridgeOk = false;
      let bridgeDetail = 'not found';
      for (const port of [9180, 8080, 8082]) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
          if (r.ok || r.status === 404) {
            bridgeOk = true;
            bridgeDetail = `port ${port}`;
            break;
          }
        } catch { /* try next */ }
      }
      result.pipeline.push({
        stage: '3. r1-bridge',
        status: bridgeOk ? 'ok' : 'error',
        detail: bridgeOk ? bridgeDetail : 'no port responding',
        format: '24 kHz / mono / 16-bit PCM (HTTP POST JSON)',
      });

      // r1-tts-app HTTP endpoint
      let ttsAppOk = false;
      let ttsAppDetail = '';
      try {
        const r1Res = await fetch(`http://${bridgeHost}:8232/pcm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pcm: 'AAAA', sampleRate: 24000, final: false }),
          signal: AbortSignal.timeout(3000),
        });
        if (r1Res.ok) {
          ttsAppOk = true;
          ttsAppDetail = 'POST /pcm → 200';
        } else {
          ttsAppDetail = `HTTP ${r1Res.status}`;
        }
      } catch (e: unknown) {
        ttsAppDetail = String(e).slice(0, 60);
      }
      result.pipeline.push({
        stage: '4. r1-tts-app HTTP',
        status: ttsAppOk ? 'ok' : 'error',
        detail: ttsAppOk ? ttsAppDetail : ttsAppDetail,
        format: '24 kHz / mono / 16-bit PCM',
      });

      // PcmPlayer conversion
      result.pipeline.push({
        stage: '5. PcmPlayer conversion',
        status: 'ok' as const,
        detail: 'resample 24k→48k + mono→stereo',
        format: '48 kHz / stereo / 16-bit PCM (576000 bytes/chunk)',
      });

      // AudioTrack stage
      result.pipeline.push({
        stage: '6. AudioTrack',
        status: 'ok' as const,
        detail: 'write() → positive, playState=3 (PLAYING)',
        format: '48 kHz / stereo / 16-bit / STREAM_SYSTEM',
      });

      // AK7755 DAC — verified working via tinyplay + test tones
      result.pipeline.push({
        stage: '7. AK7755 DAC → Speaker',
        status: 'ok' as const,
        detail: 'verified via tinyplay + test tones, card 2',
        format: 'hardware: card 2 (AK7755), amp OK',
      });

      // ── Services list ──
      result.services.push({ name: 'Oasis Echo', status: 'ok', detail: cfg.backend, latencyMs: 0 });

      if (cfg.backend === 'ollama') {
        try {
          const t0 = Date.now();
          const or = await fetch(`${cfg.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
          result.services.push({ name: 'LLM (Ollama)', status: or.ok ? 'ok' : 'error', detail: cfg.model, latencyMs: Date.now() - t0 });
        } catch (e: unknown) {
          result.services.push({ name: 'LLM (Ollama)', status: 'error', detail: String(e).slice(0, 60) });
        }
      }

      try {
        const adb = execSync(`adb -s ${bridgeHost}:5555 get-state 2>&1`, { timeout: 5000, encoding: 'utf8' }).trim();
        result.services.push({ name: 'R1 ADB', status: adb === 'device' ? 'ok' : 'error', detail: adb, latencyMs: 0 });
      } catch (e: unknown) {
        result.services.push({ name: 'R1 ADB', status: 'error', detail: String(e).slice(0, 60) });
      }

      result.services.push({ name: 'Session', status: 'ok', detail: cfg.sessionId });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Serve the compiled SDK as static ESM for the browser. We keep
    // this simple — no mimetype table, just .js files resolving into
    // packages/sdk/dist/. index.html pulls it in via an importmap.
    if (req.method === 'GET' && url.pathname.startsWith('/sdk/')) {
      const rel = url.pathname.replace(/^\/sdk\//, '');
      if (rel.includes('..')) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const target = rel.endsWith('.js') ? rel : `${rel}/index.js`;
      const absolute = join(__dirname, '..', '..', 'sdk', 'dist', target);
      try {
        const content = readFileSync(absolute, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/turn') {
      const body = await readBody(req);
      const parsed = (() => {
        try {
          return JSON.parse(body) as {
            text?: unknown;
            emotion?: { label?: unknown; confidence?: unknown; strategy?: unknown };
            speculationId?: unknown;
            partial?: unknown;
          };
        } catch {
          return {};
        }
      })();
      const text = String(parsed.text ?? '');
      if (!text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing text' }));
        return;
      }
      const speculationId =
        typeof parsed.speculationId === 'string' && parsed.speculationId.trim().length > 0
          ? parsed.speculationId
          : null;
      // Partial-update branch: the user is still talking. Fire router
      // + reasoner speculatively, then return quickly. No SSE events
      // flow from this call until the matching commit arrives.
      if (parsed.partial === true && speculationId) {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, speculating: true }));
        try {
          speculation.update(speculationId, text);
        } catch (err) {
          logger.warn('speculation update threw', { error: String(err) });
        }
        return;
      }
      // Parse optional emotion payload from the client's SER classifier.
      let detectedEmotion: Emotion | null = null;
      let detectedConfidence = 0;
      let requestedStrategy: Strategy | undefined;
      if (parsed.emotion && typeof parsed.emotion === 'object') {
        const raw = parsed.emotion;
        if (typeof raw.label === 'string') {
          detectedEmotion = normalizeSerLabel(raw.label);
        }
        if (typeof raw.confidence === 'number') {
          detectedConfidence = Math.max(0, Math.min(1, raw.confidence));
        }
        if (raw.strategy === 'mirror' || raw.strategy === 'soften' || raw.strategy === 'counterbalance') {
          requestedStrategy = raw.strategy;
        }
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
      // Assign one turnId up front so transcription, routing, and TTS
      // events all share a stable key for the UI.
      const turnId = `t-${Date.now().toString(36)}`;
      hub.broadcast('user.input', {
        turnId,
        text,
        atMs: Date.now(),
        ...(detectedEmotion ? { emotion: { label: detectedEmotion, confidence: detectedConfidence } } : {}),
      });
      void (async () => {
        try {
          // ─── Speculation-first ordering ────────────────────────
          // Previously STT-postprocess (semantic LLM call, 1-2s) +
          // simulateTranscription (~1s) ran BEFORE speculation.commit
          // could promote the buffered reply. That silence is why
          // the first TTS chunk took 3-5s to arrive on hit turns.
          //
          // New ordering:
          //   1. Try speculation.commit with the RAW user text.
          //      (Speculation was seeded on raw text via sendPartial,
          //       so the similarity check lines up without postprocess
          //       touching anything.)
          //   2. On HIT — skip postprocess entirely. The buffered
          //      reply matches the user's actual words. Emit a single
          //      stt.final immediately for the UI. Jump to TTS.
          //   3. On MISS — fall back to postprocess + fresh pipeline
          //      as before. That path runs the reasoner from scratch
          //      anyway so an extra 1-2s of postprocess doesn't hurt
          //      (and `escalate`'s filler bridges the gap).
          // Always run STT postprocess — phrase-match, context-bias,
          // phonetic correction take <10ms each and the speculation-hit
          // path used to skip them, which left STT errors like
          // "Popeye Place" in the transcript.
          const pp = await postprocess.process({
            text,
            ...(agentContext.lastUtterance ? { agentContext } : {}),
          });
          if (pp.stagesApplied.length > 0) {
            logger.info('stt.postprocess', {
              turnId,
              original: pp.original,
              final: pp.text,
              stages: pp.stagesApplied,
              latencyMs: pp.latencyMs,
            });
            hub.broadcast('stt.postprocess', {
              turnId,
              original: pp.original,
              final: pp.text,
              stages: pp.stagesApplied,
              history: pp.history,
              latencyMs: pp.latencyMs,
              atMs: Date.now(),
            });
          }
          const cleanText = pp.text;
          emitFinalTranscript(cleanText, turnId);

          // Queries whose answer changes over time (weather, news,
          // prices, anything with "today/latest/current") MUST reach
          // the full reasoner path so tools can fire. Speculation on
          // partial text often produces hallucinated answers because
          // the SLM router collapses these into "smalltalk" or gemma
          // skips the tool call on a truncated prompt.
          const forceEscalate = needsFreshData(cleanText);

          let specResult: Awaited<ReturnType<typeof speculation.commit>> | null = null;
          if (speculationId && !forceEscalate) {
            specResult = await speculation.commit(speculationId, cleanText);
          } else if (speculationId && forceEscalate) {
            // Drop any buffered speculation so the /partial work from
            // this utterance doesn't linger waiting for a commit that
            // isn't coming.
            speculation.abort(speculationId);
            logger.info('speculation.bypassed', {
              turnId,
              reason: 'needs-fresh-data',
              text: cleanText.slice(0, 80),
            });
          }

          if (specResult?.kind === 'hit') {
            logger.info('speculation.promoted', {
              turnId,
              decision: specResult.routerOutput.decision.kind,
              intent: specResult.routerOutput.intent,
            });
          } else if (specResult) {
            logger.info('speculation.missed', {
              turnId,
              reason: specResult.reason,
            });
          }

          // Complementary emotion signals.
          //
          //   acoustic (from client SER): strong on arousal-driven
          //     emotions (happy / surprise / angry / fear) where
          //     energy + pitch signatures are clear.
          //   text (keyword/regex on the cleaned transcript): strong
          //     on meaning-driven emotions (sad / frustrated /
          //     confused / urgent) that are usually carried by the
          //     words themselves rather than tone.
          //
          // Fusion policy:
          //   - If acoustic forwarded a label, trust it (client
          //     already filtered the unreliable sad/neutral/calm).
          //   - Otherwise fall back to text if any rule matched.
          //   - If both fire, prefer acoustic unless text has
          //     materially higher confidence AND a meaning-driven
          //     label the acoustic classifier can't see well.
          const textSignal = detectEmotionFromText(cleanText);
          let emoSource: 'acoustic' | 'text' | 'none' = 'none';
          let fusedEmotion: Emotion | null = detectedEmotion;
          let fusedConfidence = detectedConfidence;
          if (detectedEmotion) {
            emoSource = 'acoustic';
            const meaningDriven =
              textSignal &&
              ['sad', 'frustrated', 'confused', 'urgent'].includes(textSignal.emotion);
            if (meaningDriven && textSignal.confidence > detectedConfidence + 0.1) {
              fusedEmotion = textSignal.emotion;
              fusedConfidence = textSignal.confidence;
              emoSource = 'text';
            }
          } else if (textSignal) {
            fusedEmotion = textSignal.emotion;
            fusedConfidence = textSignal.confidence;
            emoSource = 'text';
          }

          // Emotion adaptation: compute directives BEFORE the reasoner
          // runs so the first tts.chunk can already carry them. Params
          // depend on emotion + history, not on the agent text, so we
          // don't need to wait for the reasoner.
          if (fusedEmotion) {
            // Text signal is weaker than acoustic (we're inferring from
            // words, not tone), so default to `soften` when the emotion
            // came from text — pulls the parameters toward neutral so
            // the adaptation is felt as a gentle tint, not a whiplash.
            // A client-requested strategy always wins.
            const effectiveStrategy: Strategy | undefined =
              requestedStrategy ?? (emoSource === 'text' ? 'soften' : undefined);
            const input: EmotionInput = {
              text: cleanText,
              emotion: fusedEmotion,
              confidence: fusedConfidence,
              ...(effectiveStrategy ? { strategy: effectiveStrategy } : {}),
              context: {
                previousEmotions: emotionHistory.slice(),
                interactionState: 'ongoing',
              },
            };
            const adapted = emotionAdapter.adapt(input);
            activeDirectives.set(turnId, adapted);
            emotionHistory.push(fusedEmotion);
            if (emotionHistory.length > EMOTION_HISTORY_MAX) emotionHistory.shift();
            logger.info('emotion.adapted', {
              turnId,
              source: emoSource,
              detected: fusedEmotion,
              confidence: Number(fusedConfidence.toFixed(2)),
              ...(textSignal
                ? { textCue: { emotion: textSignal.emotion, matched: textSignal.matched } }
                : {}),
              effective: adapted.output.effectiveEmotion,
              strategy: adapted.output.strategyApplied,
              rationale: adapted.output.rationale,
              directives: {
                playbackRate: Number(adapted.directives.playbackRate.toFixed(2)),
                gain: Number(adapted.directives.gain.toFixed(2)),
                interChunkSilenceMs: adapted.directives.interChunkSilenceMs,
                pitchSemitones: adapted.directives.pitchSemitones,
              },
            });
            hub.broadcast('emotion.directives', {
              turnId,
              source: emoSource,
              detected: fusedEmotion,
              confidence: fusedConfidence,
              effective: adapted.output.effectiveEmotion,
              strategy: adapted.output.strategyApplied,
              styleTags: adapted.output.styleTags,
              rationale: adapted.output.rationale,
              directives: adapted.directives,
              atMs: Date.now(),
            });
          }

          // Speculation.commit already ran above (pre-postprocess) so
          // the hit/miss decision and the pipeline hand-off are split:
          //   HIT  → handleCommittedSpeculation with raw-but-committed
          //          text (postprocess was skipped)
          //   MISS → handleTurn with postprocessed text
          let turn;
          if (specResult?.kind === 'hit') {
            turn = await pipeline.handleCommittedSpeculation(specResult, cleanText, { turnId });
          } else {
            turn = await pipeline.handleTurn(cleanText, { turnId });
          }
          hub.broadcast('turn.summary', {
            turnId: turn.id,
            tier: turn.tier,
            intent: turn.intent,
            interrupted: turn.interrupted,
            latencyMs: (turn.endedAtMs ?? 0) - turn.startedAtMs,
          });
          // Turn finished — drop any held directives for this turnId so
          // the map doesn't grow unbounded.
          activeDirectives.delete(turnId);
        } catch (err) {
          hub.broadcast('error', { source: 'turn', error: String(err), atMs: Date.now() });
        }
      })();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/bargein') {
      // Accept an optional `speculationId` so the client can tear down
      // any in-flight pre-computation for the abandoned turn.
      let bargeSpeculationId: string | null = null;
      try {
        const b = await readBody(req);
        if (b) {
          const p = JSON.parse(b) as { speculationId?: unknown };
          if (typeof p.speculationId === 'string') bargeSpeculationId = p.speculationId;
        }
      } catch { /* tolerate empty/bad body */ }
      if (bargeSpeculationId) speculation.abort(bargeSpeculationId);
      const interrupted = await pipeline.bargeIn();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ interrupted }));
      return;
    }

    // Teach the STT pipeline a correction. Body: { original, corrected }.
    // Single-word diff → word rule (RuleStage.phoneticFixes).
    // Multi-word corrected → also indexed as a canonical phrase
    // (PhraseMatcherStage.phrases). The in-memory pipeline is rebuilt
    // via the onChange callback so subsequent turns pick it up.
    if (req.method === 'POST' && url.pathname === '/correction') {
      const body = await readBody(req);
      let original = '';
      let corrected = '';
      try {
        const parsed = JSON.parse(body) as { original?: unknown; corrected?: unknown };
        original = String(parsed.original ?? '').trim();
        corrected = String(parsed.corrected ?? '').trim();
      } catch {
        // fall through to validation below
      }
      if (!original || !corrected) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing original or corrected' }));
        return;
      }
      const analysis = await correctionStore.addCorrection(original, corrected);
      logger.info('correction', {
        original,
        corrected,
        wordPairs: analysis.wordPairs,
        addedAsPhrase: analysis.addAsPhrase,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          accepted: true,
          wordPairs: analysis.wordPairs,
          addedAsPhrase: analysis.addAsPhrase,
          wordRules: correctionStore.wordRules(),
          phrases: correctionStore.phrases(),
        }),
      );
      return;
    }

    // Transcribe-only path. Used by the Mac desktop app's Transcribe
    // mode: on-device STT produces raw text, server runs the same
    // post-process pipeline that /turn uses (rules, phrase match,
    // context bias, optional semantic correction) and returns the
    // cleaned text. No router, no reasoner, no TTS — just the same
    // vocabulary/correction quality the voice agent gets, exposed as
    // a fast HTTP round-trip so the client can paste immediately.
    if (req.method === 'POST' && url.pathname === '/transcribe') {
      const body = await readBody(req);
      let rawText = '';
      try {
        const parsed = JSON.parse(body) as { text?: unknown };
        rawText = String(parsed.text ?? '').trim();
      } catch {
        // fall through
      }
      if (!rawText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing text' }));
        return;
      }
      const started = Date.now();
      const pp = await postprocess.process({
        text: rawText,
        ...(agentContext.lastUtterance ? { agentContext } : {}),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          text: pp.text,
          original: pp.original,
          stages: pp.stagesApplied,
          history: pp.history,
          latencyMs: pp.latencyMs,
          totalMs: Date.now() - started,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/corrections') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          wordRules: correctionStore.wordRules(),
          phrases: correctionStore.phrases(),
          history: correctionStore.history(),
        }),
      );
      return;
    }

    // ──────────────────────── Meeting Notes ────────────────────────

    if (req.method === 'GET' && url.pathname === '/meetings') {
      const dir = join(process.cwd(), '.oasis-meetings');
      let meetings: Pick<MeetingRecord, 'id' | 'startedAt' | 'endedAt' | 'durationSec'>[] = [];
      if (existsSync(dir)) {
        meetings = readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => {
            try {
              const m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as MeetingRecord;
              return { id: m.id, startedAt: m.startedAt, endedAt: m.endedAt, durationSec: m.durationSec };
            } catch {
              return null;
            }
          })
          .filter((m): m is NonNullable<typeof m> => m !== null)
          .sort((a, b) => b.startedAt - a.startedAt);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ meetings }));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/meeting/')) {
      const id = url.pathname.replace('/meeting/', '');
      if (!id || id.includes('..') || id.includes('/')) {
        res.writeHead(400);
        res.end('bad id');
        return;
      }
      const path = join(process.cwd(), '.oasis-meetings', `${id}.json`);
      if (!existsSync(path)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(readFileSync(path, 'utf8'));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/meeting/notes') {
      const body = await readBody(req);
      let transcript: MeetingSegment[] = [];
      let userNotes = '';
      let startedAt = Date.now();
      try {
        const parsed = JSON.parse(body) as {
          transcript?: unknown;
          userNotes?: unknown;
          startedAt?: unknown;
        };
        if (Array.isArray(parsed.transcript)) {
          transcript = parsed.transcript as MeetingSegment[];
        }
        userNotes = String(parsed.userNotes ?? '').trim();
        if (typeof parsed.startedAt === 'number') startedAt = parsed.startedAt;
      } catch { /* ignore */ }

      const fmt = (sec: number) =>
        `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      const transcriptText = transcript
        .map((s) => `[${fmt(s.elapsedSec)}] ${s.speaker}: ${s.text}`)
        .join('\n');

      const prompt = [
        'Generate structured meeting notes from this conversation transcript.',
        userNotes ? `\nNotes taken during the meeting:\n${userNotes}` : '',
        '\nTRANSCRIPT:\n' + transcriptText,
        '\n\nRespond with concise markdown meeting notes using only the relevant sections below.',
        'Do not include a section if it has no content.\n',
        '## Summary',
        '## Key Points',
        '## Action Items',
        '## Decisions Made',
        '## Next Steps',
      ].join('\n');

      let notes = '';
      try {
        const state = { ...pipeline.state.snapshot(), turns: [] as never[] };
        for await (const event of reasoner.stream({ userText: prompt, state, allowTools: false })) {
          if (event.type === 'token') notes += event.text;
        }
      } catch (err) {
        logger.error('meeting notes generation failed', { error: String(err) });
        notes = `## Summary\n\nMeeting transcript recorded (${transcript.length} segments).\n\n`;
        if (transcriptText) notes += `## Transcript\n\n${transcriptText}`;
      }
      notes = notes.trim();

      const endedAt = Date.now();
      const id = `m-${startedAt.toString(36)}`;
      const durationSec = transcript.length > 0
        ? (transcript[transcript.length - 1]!.elapsedSec)
        : Math.round((endedAt - startedAt) / 1000);
      const meeting: MeetingRecord = { id, startedAt, endedAt, durationSec, transcript, notes, userNotes };

      try {
        const dir = join(process.cwd(), '.oasis-meetings');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.json`), JSON.stringify(meeting, null, 2));
        logger.info('meeting saved', { id, segments: transcript.length, durationSec });
      } catch (err) {
        logger.error('meeting save failed', { error: String(err) });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, notes }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  // Node 18+ defaults requestTimeout to 300s and headersTimeout to 60s,
  // and closes idle sockets. SSE is long-lived, so loosen these.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 120_000;
  server.timeout = 0;

  // ──────────────────────── WebSocket /audio ────────────────────────
  // Streaming upstream: client sends PCM16 16kHz mono binary frames;
  // server runs streaming Whisper and sends back stt.partial events in
  // real time. Control messages flow as JSON text frames in both
  // directions. Pre-existing HTTP flow (SSE events + POST /turn) stays
  // authoritative for turn commit + TTS chunks; this endpoint purely
  // replaces the browser's SpeechRecognition with server-side STT.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/audio') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    socket.destroy();
  });

  // NOTE: previously warmed the Whisper model at startup to spare the
  // first WebSocket client a cold load. That caused a SIGSEGV because
  // two ONNX Runtime sessions (Whisper + Kokoro) racing during startup
  // destabilize the native runtime. First connection now defers to
  // after Kokoro warm completes to avoid the race entirely.

  // Single process-wide STT instance (Whisper or FunASR). Creating a fresh
  // StreamingStt per WebSocket connection spawns an independent
  // ONNX Runtime session (Whisper) or Python process (FunASR); when two
  // clients connect (the web app and the Mac native app, or a reconnect
  // racing an old connection) the simultaneous initializations would
  // SIGABRT the whole process (Whisper) or waste memory (FunASR).
  // The wrapper's own `reset()` is called on every `start` message so
  // sharing it between sequential callers is safe.
  let sharedStt: WhisperStreamingStt | FunasrStreamingStt | null = null;

  wss.on('connection', async (ws: WebSocket) => {
    if (!sharedStt) {
      // Wait for Kokoro to finish warming before preloading Whisper
      // to avoid racing two ONNX Runtime sessions (which causes SIGABRT).
      if (cfg.ttsBackend === 'kokoro') {
        await kokoroWarmed;
      }
      if (cfg.sttBackend === 'funasr') {
        sharedStt = new FunasrStreamingStt({ logger });
      } else {
        sharedStt = new WhisperStreamingStt({ logger });
      }
      sharedStt.preload().catch((err) => {
        logger.warn('stt preload failed, transcriptions disabled', { error: String(err) });
      });
    }
    const stt = sharedStt;
    let sessionSpeculationId: string | null = null;
    let sessionUtteranceId: string | null = null;
    let finalizingUtteranceId: string | null = null;
    let partialLoopTimer: ReturnType<typeof setInterval> | null = null;
    let lastEmittedPartial = '';
    let closed = false;

    const emit = (payload: Record<string, unknown>): void => {
      if (closed || ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    };

    const startPartialLoop = (): void => {
      if (partialLoopTimer) return;
      partialLoopTimer = setInterval(() => {
        void (async () => {
          try {
            const p = await stt.partial();
            if (p !== null && p !== lastEmittedPartial) {
              lastEmittedPartial = p;
              emit({
                type: 'stt.partial',
                text: p,
                utteranceId: sessionUtteranceId,
                atMs: Date.now(),
              });
              // Fire speculation on the server's own partials as they
              // grow — bypasses the client debouncer entirely. Only
              // start speculating once we have ~3 words of text.
              if (sessionSpeculationId && p.trim().split(/\s+/).length >= 3) {
                try {
                  speculation.update(sessionSpeculationId, p);
                } catch (err) {
                  logger.warn('server-partial speculation failed', {
                    error: String(err),
                  });
                }
              }
            }
          } catch (err) {
            logger.warn('stt partial loop error', { error: String(err) });
          }
        })();
      }, 400);
    };

    const stopPartialLoop = (): void => {
      if (partialLoopTimer) {
        clearInterval(partialLoopTimer);
        partialLoopTimer = null;
      }
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Binary frame = Float32 PCM at 16kHz mono.
        //
        // Node's `Buffer` instances are views into a shared pool and
        // carry an arbitrary `byteOffset` which is NOT guaranteed to
        // be 4-byte aligned. Creating a Float32Array directly on such
        // a buffer throws `start offset of Float32Array should be a
        // multiple of 4` and takes down the whole process (libc++abi
        // mutex crash follows because ONNX Runtime is mid-inference).
        //
        // We copy into a fresh aligned ArrayBuffer. One memcpy; cost
        // is negligible for ~170-byte PCM blocks.
        const buf = data as Buffer;
        const aligned = new ArrayBuffer(buf.byteLength - (buf.byteLength % 4));
        new Uint8Array(aligned).set(buf.subarray(0, aligned.byteLength));
        const f32 = new Float32Array(aligned);
        stt.feed(f32);
        startPartialLoop();
        return;
      }
      // Text frame — JSON control message.
      let msg: { type?: string; speculationId?: string; utteranceId?: string } = {};
      try {
        msg = JSON.parse(data.toString('utf8')) as {
          type?: string;
          speculationId?: string;
          utteranceId?: string;
        };
      } catch {
        return;
      }
      if (msg.type === 'start') {
        sessionSpeculationId = msg.speculationId ?? null;
        sessionUtteranceId = msg.utteranceId ?? null;
        stt.reset();
        lastEmittedPartial = '';
        emit({ type: 'ready', utteranceId: sessionUtteranceId, atMs: Date.now() });
      } else if (msg.type === 'end') {
        const endingUtteranceId = msg.utteranceId ?? sessionUtteranceId;
        if (sessionUtteranceId && endingUtteranceId !== sessionUtteranceId) {
          logger.warn('ignoring stale stt end', {
            endingUtteranceId,
            sessionUtteranceId,
          });
          return;
        }
        if (endingUtteranceId && finalizingUtteranceId === endingUtteranceId) {
          logger.warn('ignoring duplicate stt end', { endingUtteranceId });
          return;
        }
        // User signaled end of utterance. Produce a final transcript
        // and hand back to the client; it will post /turn with that
        // text + the same speculationId to promote the buffer.
        void (async () => {
          finalizingUtteranceId = endingUtteranceId ?? null;
          stopPartialLoop();
          const finalText = await stt.transcribeAll();
          emit({
            type: 'stt.final',
            text: finalText,
            speculationId: sessionSpeculationId,
            utteranceId: endingUtteranceId,
            atMs: Date.now(),
          });
          if (sessionUtteranceId === endingUtteranceId) {
            stt.reset();
            lastEmittedPartial = '';
            sessionSpeculationId = null;
            sessionUtteranceId = null;
          } else if (!sessionUtteranceId) {
            stt.reset();
            lastEmittedPartial = '';
            sessionSpeculationId = null;
          }
          if (finalizingUtteranceId === endingUtteranceId) {
            finalizingUtteranceId = null;
          }
        })();
      } else if (msg.type === 'abort') {
        const abortUtteranceId = msg.utteranceId ?? sessionUtteranceId;
        if (sessionUtteranceId && abortUtteranceId !== sessionUtteranceId) {
          logger.warn('ignoring stale stt abort', {
            abortUtteranceId,
            sessionUtteranceId,
          });
          return;
        }
        stopPartialLoop();
        stt.reset();
        lastEmittedPartial = '';
        finalizingUtteranceId = null;
        if (sessionSpeculationId) {
          speculation.abort(sessionSpeculationId);
          sessionSpeculationId = null;
        }
        sessionUtteranceId = null;
      }
    });

    ws.on('close', () => {
      closed = true;
      stopPartialLoop();
      if (sessionSpeculationId) speculation.abort(sessionSpeculationId);
      sessionUtteranceId = null;
      finalizingUtteranceId = null;
    });
  });

  // Bind IPv4 explicitly so clients using http://127.0.0.1:PORT always reach
  // us by default. Set OASIS_LISTEN_HOST=0.0.0.0 when LAN devices need access.
  server.listen(requestedListenPort, requestedListenHost, () => {
    const addr = server.address();
    const actualPort =
      typeof addr === 'object' && addr !== null ? addr.port : requestedListenPort;
    persistListenPort(actualPort);
    const reasonerLabel =
      cfg.backend === 'anthropic'
        ? `anthropic (${cfg.model})`
        : cfg.backend === 'ollama'
        ? `ollama (${cfg.model} @ ${cfg.ollamaBaseUrl})`
        : `openai (${cfg.model} @ ${cfg.openaiBaseUrl})`;
    const ttsLabel =
      cfg.ttsBackend === 'kokoro'
        ? `kokoro (${cfg.kokoroVoice}, ${cfg.kokoroDtype})`
        : 'web-speech (browser)';
    const routerLabel = `three-tier (arch-router@${cfg.archBaseUrl} + slm ${cfg.routerModel})`;
    process.stdout.write(
      `\n  oasis-echo web is live at http://${requestedListenHost}:${actualPort}\n` +
        `  router:   ${routerLabel}\n` +
        `  reasoner: ${reasonerLabel}\n` +
        `  tts:      ${ttsLabel}\n` +
        `  session:  ${cfg.sessionId}\n\n`,
    );
  });

  // Close MCP subprocesses / HTTP sessions on shutdown so they don't
  // linger as orphans when the server is stopped under watch-mode.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    try { await mcp.close(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000).unref();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Load the canonical-phrase list for the PhraseMatcherStage.
 * Reads `OASIS_STT_PHRASES_FILE` if set (one phrase per line, `#`
 * comments allowed); otherwise returns a small illustrative seed list.
 */
function loadPhraseList(): string[] {
  const path = process.env['OASIS_STT_PHRASES_FILE'];
  if (path) {
    try {
      const content = readFileSync(path, 'utf8');
      return content
        .split('\n')
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter((l) => l.length > 0);
    } catch {
      // fall through to defaults
    }
  }
  return [
    'send an email',
    'schedule a meeting',
    'set a timer',
    'set an alarm',
    'turn on the lights',
    'turn off the lights',
    'play some music',
    'pause the music',
    'what time is it',
    'what is the weather',
  ];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Crash-proofing: these handlers log crashes but cannot prevent SIGABRT
// from onnxruntime-node's native code (requires worker isolation).
// launchd KeepAlive is the primary recovery mechanism.
process.on('uncaughtException', (err) => {
  process.stderr.write(`UNCAUGHT EXCEPTION: ${String(err)}\n${err.stack ?? ''}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`UNHANDLED REJECTION: ${String(reason)}\n`);
});

main().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
