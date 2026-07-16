// Validates a project-extraction git clone URL before it reaches `git clone`.
//
// Two command-injection vectors are in scope: git's alternate transports
// (e.g. `ext::`, `fd::`) can execute arbitrary local commands, and a value
// starting with `-` is parsed by git as an option (e.g. `--upload-pack=...`)
// rather than a URL. Both are blocked by only allowing a short list of known
// safe schemes; anything else (including `file://`) is rejected.
const ALLOWED_GIT_URL_PREFIXES = ['https://', 'git@', 'ssh://'];

export function assertSafeGitCloneUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('git URL is empty');
  if (trimmed.startsWith('-')) {
    throw new Error(`git URL must not start with '-' (option injection): ${trimmed}`);
  }
  if (!ALLOWED_GIT_URL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    throw new Error(
      `git URL must start with one of: ${ALLOWED_GIT_URL_PREFIXES.join(', ')} (got: ${trimmed})`,
    );
  }
}
