import { spawn } from 'node:child_process';
import { assertSafeGitCloneUrl } from '@pitchbox/shared/project-extraction';

/** What a private clone authenticates with: a GitHub App installation token
 * presented as HTTP basic auth, which is how GitHub accepts one over https
 * (`x-access-token` as the username). Minted per clone by the caller
 * (cli/src/commands/project.ts), never stored. */
export type CloneCredential = { username: string; token: string };

export type CloneOptions = { timeoutMs?: number; credential?: CloneCredential | null };

/**
 * The environment `git clone` runs with.
 *
 * A credential goes in `http.<origin>.extraheader` **through the
 * environment**, never into the URL or into argv: a token in argv is readable
 * by every process on the box through `/proc/<pid>/cmdline`, and a token in
 * the URL additionally ends up in git's own error text. Scoping the config
 * key to the clone URL's own origin keeps the header off a redirect to any
 * other host.
 *
 * `GIT_CONFIG_COUNT` is read from the ambient environment first, so an
 * operator's own `GIT_CONFIG_*` pairs are extended rather than replaced.
 */
function cloneEnv(
  url: string,
  credential: CloneCredential | null,
): Record<string, string | undefined> {
  // Nothing can be typed in here, so a clone that needs a credential and does
  // not have one must fail with git's own message instead of blocking until
  // the timeout kills it.
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
  if (!credential) return env;

  let origin: string;
  try {
    const parsed = new URL(url);
    origin = `${parsed.protocol}//${parsed.host}/`;
  } catch {
    // Not an https URL (scp-style or ssh): an extraheader would not apply to
    // it, so the clone runs as it would have without a credential.
    return env;
  }

  const ambient = Number(process.env.GIT_CONFIG_COUNT ?? '');
  const index = Number.isInteger(ambient) && ambient > 0 ? ambient : 0;
  const basic = Buffer.from(`${credential.username}:${credential.token}`).toString('base64');
  env[`GIT_CONFIG_KEY_${index}`] = `http.${origin}.extraheader`;
  env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${basic}`;
  env.GIT_CONFIG_COUNT = String(index + 1);
  return env;
}

export async function shallowClone(
  url: string,
  dest: string,
  opts: CloneOptions = {},
): Promise<void> {
  if (!url || !url.trim()) throw new Error('git URL is empty');
  assertSafeGitCloneUrl(url);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const env = cloneEnv(url, opts.credential ?? null);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth=1', url, dest], { stdio: 'pipe', env });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git clone timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (b) => (stderr += String(b)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git clone failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}
