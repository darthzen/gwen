// One JSON object per line. Never pass secrets or message bodies at info level;
// turn records carry sizes and timings, which is what the latency record needs.
type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  info: (msg: string, f?: Fields) => emit('info', msg, f),
  warn: (msg: string, f?: Fields) => emit('warn', msg, f),
  error: (msg: string, f?: Fields) => emit('error', msg, f),
  debug: (msg: string, f?: Fields) => {
    if (process.env.GWEN_DEBUG) emit('debug', msg, f);
  },
};

export function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
