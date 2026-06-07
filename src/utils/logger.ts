type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: '  DEBUG',
  info: '   INFO',
  warn: '   WARN',
  error: '  ERROR',
};

function fmt(level: LogLevel, msg: string, data?: unknown): void {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `[${ts}]${LEVEL_PREFIX[level]} ${msg}`;
  if (level === 'error') {
    console.error(line, data ?? '');
  } else if (level === 'warn') {
    console.warn(line, data ?? '');
  } else {
    console.log(line, data ?? '');
  }
}

export const logger = {
  debug: (msg: string, data?: unknown) => fmt('debug', msg, data),
  info: (msg: string, data?: unknown) => fmt('info', msg, data),
  warn: (msg: string, data?: unknown) => fmt('warn', msg, data),
  error: (msg: string, data?: unknown) => fmt('error', msg, data),
};
