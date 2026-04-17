import { performance } from 'node:perf_hooks';

export type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startedAtMs: number;
  endedAtMs?: number;
  attributes: Record<string, unknown>;
};

export type TracerSink = (span: Span) => void;

export class Tracer {
  private readonly sink: TracerSink;

  constructor(sink?: TracerSink) {
    this.sink = sink ?? (() => {});
  }

  start(name: string, parent?: Span, attributes: Record<string, unknown> = {}): Span {
    return {
      name,
      traceId: parent?.traceId ?? randomId(16),
      spanId: randomId(8),
      ...(parent?.spanId !== undefined ? { parentSpanId: parent.spanId } : {}),
      startedAtMs: performance.now(),
      attributes: { ...attributes },
    };
  }

  end(span: Span, extra: Record<string, unknown> = {}): void {
    span.endedAtMs = performance.now();
    Object.assign(span.attributes, extra);
    this.sink(span);
  }

  async measure<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    parent?: Span,
    attributes: Record<string, unknown> = {},
  ): Promise<T> {
    const span = this.start(name, parent, attributes);
    try {
      return await fn(span);
    } catch (err) {
      span.attributes['error'] = String(err);
      throw err;
    } finally {
      this.end(span);
    }
  }
}

function randomId(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}
