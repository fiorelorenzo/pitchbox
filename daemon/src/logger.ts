type Level = 'info' | 'warn' | 'error' | 'debug';

function ts(): string {
  return new Date().toISOString();
}

function write(level: Level, module: string, msg: string, extra?: unknown) {
  const line = `${ts()} [${level}] [${module}] ${msg}`;
  if (level === 'error') console.error(line, extra ?? '');
  else if (level === 'warn') console.warn(line, extra ?? '');
  else console.log(line, extra ?? '');
}

export function logger(module: string) {
  return {
    info: (msg: string, extra?: unknown) => write('info', module, msg, extra),
    warn: (msg: string, extra?: unknown) => write('warn', module, msg, extra),
    error: (msg: string, extra?: unknown) => write('error', module, msg, extra),
    debug: (msg: string, extra?: unknown) => {
      if (process.env.PITCHBOX_DEBUG) write('debug', module, msg, extra);
    },
  };
}
