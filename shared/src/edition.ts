// Edition flag - single source of truth for whether the running process is
// the OSS self-hosted build or the cloud build. Cloud-only code lives in a
// private submodule under `cloud/` (gitignored in this repo). Build tooling
// is expected to discover that path and wire it in; this helper is the
// runtime gate used by the dispatch path and the dashboard.

export type Edition = 'self-hosted' | 'cloud';

export function currentEdition(): Edition {
  return process.env.PITCHBOX_EDITION === 'cloud' ? 'cloud' : 'self-hosted';
}

export function isCloud(): boolean {
  return currentEdition() === 'cloud';
}
