import { MockTts } from '@oasis-echo/coordinator';
import { Pipeline } from '@oasis-echo/orchestrator';
import { MockReasoner, ToolRegistry, echoTool, timeTool } from '@oasis-echo/reasoning';
import { createLogger, Metrics, Tracer } from '@oasis-echo/telemetry';

/**
 * Scripted end-to-end driver that exercises all three tiers and a
 * barge-in, then prints final metrics. Useful for CI smoke tests.
 */
export async function runDemo(): Promise<void> {
  const logger = createLogger({ level: 'info' });
  const metrics = new Metrics();
  const tools = new ToolRegistry();
  tools.register(timeTool());
  tools.register(echoTool());

  const pipeline = new Pipeline({
    sessionId: 'demo',
    reasoner: new MockReasoner({ delayMs: 10 }),
    tts: new MockTts(),
    logger,
    metrics,
    tracer: new Tracer(),
  });

  pipeline.bus.on('tts.chunk', (e) => {
    const text = new TextDecoder().decode(
      new Uint8Array(e.pcm.buffer, e.pcm.byteOffset, e.pcm.byteLength),
    );
    if (e.final) {
      process.stdout.write(`    agent: ${text}\n`);
    }
  });

  pipeline.bus.on('bargein', (e) => {
    process.stdout.write(`    [barge-in on ${e.interruptedTurnId}]\n`);
  });

  const lines = [
    'hello',
    'sure',
    'why is the ocean salty',
    'schedule a meeting for tomorrow at 3pm',
    'email alice@example.com the details',
    'yes',
  ];

  for (const line of lines) {
    process.stdout.write(`\n  user: ${line}\n`);
    const turn = await pipeline.handleTurn(line);
    process.stdout.write(
      `    [${turn.tier}, intent=${turn.intent}, ${(turn.endedAtMs ?? 0) - turn.startedAtMs}ms]\n`,
    );
  }

  // Barge-in demo: start a long turn, interrupt after 30ms
  process.stdout.write('\n  user: explain the theory of relativity in detail\n');
  const slowPipeline = new Pipeline({
    sessionId: 'demo-bargein',
    reasoner: new MockReasoner({
      tokens: Array(20).fill('content '),
      delayMs: 25,
    }),
    tts: new MockTts(),
    logger,
    metrics,
  });
  slowPipeline.bus.on('bargein', (e) => {
    process.stdout.write(`    [barge-in on ${e.interruptedTurnId}]\n`);
  });
  const promise = slowPipeline.handleTurn('explain the theory of relativity in detail');
  await new Promise((r) => setTimeout(r, 80));
  await slowPipeline.bargeIn();
  const interrupted = await promise;
  process.stdout.write(
    `    [${interrupted.tier}, interrupted=${interrupted.interrupted}, ${(interrupted.endedAtMs ?? 0) - interrupted.startedAtMs}ms]\n`,
  );

  const final = pipeline.state.snapshot();
  process.stdout.write('\n── session state ─────────────\n');
  process.stdout.write(
    JSON.stringify({ phase: final.phase, turns: final.turns.length, summary: final.summary }, null, 2) + '\n',
  );

  process.stdout.write('\n── metrics ───────────────────\n');
  const snap = metrics.snapshot();
  for (const c of snap.counters) {
    process.stdout.write(`${c.name}${labelStr(c.labels)} = ${c.value}\n`);
  }
  for (const h of snap.histograms) {
    process.stdout.write(
      `${h.name}${labelStr(h.labels)} count=${h.count} p50=${h.p50}ms p95=${h.p95}ms p99=${h.p99}ms\n`,
    );
  }
}

function labelStr(labels: Record<string, string | number>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}=${labels[k]}`).join(',') + '}';
}

runDemo().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
