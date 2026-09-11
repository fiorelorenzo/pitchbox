// Proves a repository URL is reachable without cloning it.
//
// A `git` project source is read in full by a description run, which clones
// it (cli/src/lib/git-clone.ts). That happens minutes or days after somebody
// typed the URL, so the re-sync button needs a cheap way to answer "is this
// a repository I can actually read" now: `git ls-remote --heads` is one
// network round trip, transfers no objects, and fails the same way a clone
// would (bad host, private repo with no credential, typo in the path).
//
// GitHub URLs never come here - `project-source-sync.ts` reads their
// metadata through the API instead, which also gives the agent a README
// excerpt to fall back on. This is the path for every other host.
//
// The URL goes through `assertSafeGitCloneUrl` first, for the same reason
// the clone does: `ls-remote` hands its argument to git and, for an
// scp-style or ssh URL, to `ssh` (CVE-2017-1000117).
import { spawn } from 'node:child_process';
import { assertSafeGitCloneUrl } from './git-url.js';

export type LsRemoteResult = { branches: string[] };

/** Injectable for tests, so nothing in a suite reaches a real remote. */
export type GitLsRemote = (url: string) => Promise<LsRemoteResult>;

/**
 * Lists the branch names a remote advertises. Rejects when git is missing,
 * the URL is unsafe, the remote refuses us, or the call outlives
 * `timeoutMs` - the caller turns any of those into a `fetch_error` on the
 * row rather than a thrown 500.
 */
export async function lsRemoteBranches(url: string, timeoutMs = 20_000): Promise<LsRemoteResult> {
  assertSafeGitCloneUrl(url);
  return new Promise<LsRemoteResult>((resolve, reject) => {
    // `GIT_TERMINAL_PROMPT=0` matters more here than in the clone: a private
    // repository would otherwise block on a credential prompt that nothing
    // in a server process can ever answer, and the call would only end at
    // the timeout below instead of reporting the real reason.
    const child = spawn('git', ['ls-remote', '--heads', url], {
      stdio: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ls-remote timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (b) => (stdout += String(b)));
    child.stderr.on('data', (b) => (stderr += String(b)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`git ls-remote failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      const branches = stdout
        .split('\n')
        .map((line) => line.split('\t')[1] ?? '')
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length));
      resolve({ branches });
    });
  });
}
