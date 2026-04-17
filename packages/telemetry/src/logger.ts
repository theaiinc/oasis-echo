export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
  child: (bindings: LogFields) => Logger;
};

export function createLogger(opts: {
  level?: LogLevel;
  bindings?: LogFields;
  sink?: (line: string) => void;
} = {}): Logger {
  const level = opts.level ?? (process.env['OASIS_LOG_LEVEL'] as LogLevel) ?? 'info';
  const bindings = opts.bindings ?? {};
  const sink = opts.sink ?? ((line) => process.stderr.write(line + '\n'));

  function emit(l: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[l] < LEVEL_RANK[level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level: l,
      msg,
      ...bindings,
      ...fields,
    };
    sink(JSON.stringify(entry));
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra }, sink }),
  };
}
