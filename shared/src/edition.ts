// Edition flag - single source of truth for whether the running process is
// the OSS self-hosted build or the cloud build. Cloud-only code lives in a
// private submodule under `cloud/` (gitignored in this repo). Build tooling
// is expected to discover that path and wire it in; this helper is the
// runtime gate used by the dispatch path and the dashboard.

import { AGENT_RUNNER_META, type AgentRunnerSlug } from './agents/meta.js';

export type Edition = 'self-hosted' | 'cloud';

export function currentEdition(): Edition {
  return process.env.PITCHBOX_EDITION === 'cloud' ? 'cloud' : 'self-hosted';
}

export function isCloud(): boolean {
  return currentEdition() === 'cloud';
}

/**
 * The runner slugs a caller may pick in this edition, asked by every picker
 * (campaign/project forms, the Settings runners page) and every route that
 * persists a runner slug, so the cloud/self-hosted line is drawn once
 * instead of re-derived per call site. A cloud deployment only ever
 * dispatches to the managed runner (`shared/src/agents/cloud.ts`): every
 * local ACP backend is excluded here outright, not merely deprioritized,
 * because whether a local CLI binary happens to be reachable on a cloud
 * container's PATH says nothing about whether it should run there (#410) -
 * a cloud web/daemon image can carry `claude`, `codex`, etc. for reasons
 * unrelated to the deployment's architecture, and detection alone is not a
 * trustworthy gate. Self-hosted keeps the full catalogue, matching the
 * behavior before this function existed.
 */
export function allowedRunnerSlugs(): AgentRunnerSlug[] {
  return isCloud() ? ['cloud'] : AGENT_RUNNER_META.map((m) => m.slug);
}

/**
 * Whether `slug` is one this edition may dispatch to at all - used by every
 * write path (the API routes) as the actual boundary check, since a picker
 * that merely hides an option is not enforcement (a stale tab, an old row,
 * or a direct call still reaches the route).
 *
 * Deliberately not "is `slug` in `allowedRunnerSlugs()`": self-hosted never
 * validated a runner slug against the catalogue at the API layer - an
 * unregistered string fails later, at `createAgentRunner` - and several
 * tests rely on posting a deliberately-fake slug through untouched (see
 * `campaign-cron-validation.test.ts`'s `NO_OP_RUNNER`). The only thing this
 * guard adds is the cloud boundary: cloud dispatches to nothing but the
 * managed runner, full stop.
 */
export function isRunnerAllowed(slug: string): boolean {
  return !isCloud() || slug === 'cloud';
}
