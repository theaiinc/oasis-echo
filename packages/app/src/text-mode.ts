import * as readline from 'node:readline/promises';
import { MockTts } from '@oasis-echo/coordinator';
import { Pipeline } from '@oasis-echo/orchestrator';
import {
  AnthropicReasoner,
  MockReasoner,
  ToolRegistry,
  echoTool,
  timeTool,
  type Reasoner,
} from '@oasis-echo/reasoning';
import { createLogger, Metrics, Tracer } from '@oasis-echo/telemetry';
import { loadConfig } from './config.js';

/**
 * Text-mode REPL: user types a line, pipeline runs the full tiered
 * flow, and chunked "TTS" output is printed as it streams. Proves the
 * orchestration spine without requiring audio hardware.
 *
 *   "bargein" on its own line triggers an immediate interruption of
 *   the last turn (if still speaking). Useful for demoing the arbiter.
 */
export async function runTextMode(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel, bindings: { session: cfg.sessionId } });
  const metrics = new Metrics();
  const tracer = new Tracer();

  const tools = new ToolRegistry();
  tools.register(timeTool());
  tools.register(echoTool());

  let reasoner: Reasoner;
  if (cfg.cloudEnabled) {
    reasoner = new AnthropicReasoner({ logger, tools, model: cfg.model });
    logger.info('reasoner', { backend: 'anthropic', model: cfg.model });
  } else {
    reasoner = new MockReasoner();
    logger.info('reasoner', { backend: 'mock', reason: 'no ANTHROPIC_API_KEY' });
  }

  const pipeline = new Pipeline({
    sessionId: cfg.sessionId,
    reasoner,
    tts: new MockTts(),
    logger,
    metrics,
    tracer,
  });

  // Render streaming TTS chunks as they arrive
  let pendingLine = '';
  pipeline.bus.on('tts.chunk', (ev) => {
    const text = new TextDecoder().decode(
      new Uint8Array(ev.pcm.buffer, ev.pcm.byteOffset, ev.pcm.byteLength),
    );
    pendingLine += text;
    if (ev.final) {
      process.stdout.write(`\n  agent: ${pendingLine}\n`);
      pendingLine = '';
    }
  });
  pipeline.bus.on('route.decision', (ev) => {
    logger.debug('route', { decision: ev.decision });
  });
  pipeline.bus.on('bargein', (ev) => {
    process.stdout.write(`\n  [barge-in on ${ev.interruptedTurnId}]\n`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write('oasis-echo text-mode — type a line, "bargein", or Ctrl-D to exit\n\n');

  while (true) {
    const line = await rl.question('  user: ').catch(() => null);
    if (line === null) break;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed === 'bargein') {
      await pipeline.bargeIn();
      continue;
    }
    if (trimmed === '/metrics') {
      process.stdout.write(JSON.stringify(metrics.snapshot(), null, 2) + '\n');
      continue;
    }
    if (trimmed === '/state') {
      const s = pipeline.state.snapshot();
      process.stdout.write(
        JSON.stringify({ phase: s.phase, slots: s.slots, turns: s.turns.length, summary: s.summary }, null, 2) + '\n',
      );
      continue;
    }
    try {
      const turn = await pipeline.handleTurn(trimmed);
      logger.debug('turn', {
        id: turn.id,
        tier: turn.tier,
        latencyMs: (turn.endedAtMs ?? 0) - turn.startedAtMs,
      });
    } catch (err) {
      logger.error('turn failed', { error: String(err) });
    }
  }

  rl.close();
  process.stdout.write('\nfinal metrics:\n' + JSON.stringify(metrics.snapshot(), null, 2) + '\n');
}
