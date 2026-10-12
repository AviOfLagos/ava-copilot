/**
 * Structured logs, one JSON object per line. Only short scalar fields are kept, and every string is
 * redacted first: no bearer tokens, API keys, pairing codes, view keys or request bodies ever reach a log.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g,
  /\b(api[_-]?key|token|secret|password|authorization)\b(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
  // Long random-looking runs: tokens, keys, view keys
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

/** A text with anything that looks like a secret replaced. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // Keep the name of a key=value pair, drop its value
      if (typeof groups[0] === 'string' && typeof groups[1] === 'string' && /[:=]/.test(groups[1])) {
        return `${groups[0]}${groups[1]}[redacted]`;
      }
      return match.toLowerCase().startsWith('bearer') ? 'Bearer [redacted]' : '[redacted]';
    });
  }
  return out;
}

function clean(fields: LogFields | undefined): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    out[key] = typeof value === 'string' ? redact(value).slice(0, 300) : value;
  }
  return out;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  base: LogFields = {},
  options: { level?: LogLevel; write?: (line: string) => void; now?: () => number } = {},
): Logger {
  const minimum = ORDER[options.level ?? (process.env.AVI_BRAIN_LOG_LEVEL as LogLevel | undefined) ?? 'info'] ?? 20;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const emit = (level: LogLevel, message: string, fields?: LogFields) => {
    if (ORDER[level] < minimum) return;
    write(
      JSON.stringify({
        t: new Date(now()).toISOString(),
        level,
        msg: redact(message).slice(0, 500),
        ...clean(base),
        ...clean(fields),
      }),
    );
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: fields => createLogger({ ...base, ...fields }, options),
  };
}

/** A logger that keeps lines in memory, for tests. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return Object.assign(createLogger({}, { level: 'debug', write: line => lines.push(line) }), { lines });
}
