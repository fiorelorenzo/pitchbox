// Validates a project-extraction git clone URL before it reaches `git clone`.
//
// Command-injection vectors in scope:
//   1. git alternate transports (e.g. `ext::`, `fd::`) can execute arbitrary
//      local commands, so only a short allow-list of schemes is accepted.
//   2. A value starting with `-` is parsed by git as an option (e.g.
//      `--upload-pack=...`) rather than a URL.
//   3. A `-`-leading host smuggled into an scp-style or ssh URL (e.g.
//      `git@-oProxyCommand=...:x/y.git`) is passed straight to the `ssh` binary
//      as an option (CVE-2017-1000117). git does NOT guard the scp-style form
//      itself, so we validate the host component: it must begin with an
//      alphanumeric and contain only host-safe characters.
const ALLOWED_GIT_URL_PREFIXES = ['https://', 'git@', 'ssh://'];
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

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
  const host = gitUrlHost(trimmed);
  if (!host || !SAFE_HOST.test(host)) {
    throw new Error(`git URL has an unsafe or unparseable host: ${trimmed}`);
  }
}

// Extracts the host from an allow-listed clone URL. scp-style `git@host:path`
// is not a parseable URL, so it is handled directly; https/ssh go through the
// URL parser, which strips any userinfo and port.
function gitUrlHost(url: string): string | null {
  if (url.startsWith('git@')) {
    const afterUser = url.slice('git@'.length);
    const colon = afterUser.indexOf(':');
    if (colon <= 0) return null;
    return afterUser.slice(0, colon);
  }
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
