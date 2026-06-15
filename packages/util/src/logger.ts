import type { Logger } from '@vn/types';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Minimal structured logger writing one JSON-ish line per event to stderr. */
class ConsoleLogger implements Logger {
  constructor(
    private readonly min: Level,
    private readonly base: Record<string, unknown>,
  ) {}

  private emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.min]) return;
    const merged = { ...this.base, ...fields };
    const tail = Object.keys(merged).length ? ' ' + JSON.stringify(merged) : '';
    process.stderr.write(`[${level}] ${msg}${tail}\n`);
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields);
  }
  child(fields: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.min, { ...this.base, ...fields });
  }
}

/** Create a logger; level defaults from `VNGEN_LOG` (debug|info|warn|error). */
export function createLogger(min?: Level): Logger {
  const env = (process.env['VNGEN_LOG'] as Level | undefined) ?? min ?? 'info';
  return new ConsoleLogger(env, {});
}
