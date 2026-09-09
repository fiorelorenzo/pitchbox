// A password must never arrive as a command-line argument: argv lands in
// shell history and is visible to every other process on the box via `ps`.
// This is the one place `user:create` and `user:reset-password` read a
// secret from, in priority order:
//
//   1. the named environment variable (the deploy-pipeline / scripted case,
//      same convention as `PITCHBOX_OWNER_PASSWORD` in seed-owner.ts)
//   2. stdin, when it is not a TTY (piped input - `echo "$PW" | pitchbox ...`)
//   3. an interactive, echo-suppressed prompt, when stdin *is* a TTY
//
// Callers must say which applies in their own `--help` text (see user.ts).
export async function readSecret(envVar: string, promptLabel: string): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    return await readStdin();
  }
  return await promptMasked(promptLabel);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

// cli/tsconfig.json targets ES2022 (no lib.es2024), so `Promise.withResolvers`
// isn't available here - the executor form is the one that typechecks.
function promptMasked(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    process.stdout.write(label);
    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (raw: string) => {
      const char = raw.toString();
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          cleanup();
          process.stdout.write('\n');
          resolve(input);
          break;
        case '\u0003': // Ctrl-C
          cleanup();
          process.stdout.write('\n');
          reject(new Error('aborted'));
          break;
        case '\u007f': // backspace
        case '\b':
          input = input.slice(0, -1);
          break;
        default:
          input += char;
          break;
      }
    };
    stdin.on('data', onData);
  });
}
