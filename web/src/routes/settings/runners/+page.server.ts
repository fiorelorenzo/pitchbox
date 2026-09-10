import type { PageServerLoad } from './$types';
import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
import { detectAllRunners } from '@pitchbox/shared/agents/detect';
import {
  loadRunnerConfigs,
  loadDefaultRunnerSlug,
  type RunnerConfig,
} from '@pitchbox/shared/agents/config';
import { allowedRunnerSlugs, isCloud } from '@pitchbox/shared/edition';
import { isInstanceAdmin } from '../../../lib/server/auth.js';
import { getDb } from '../../../lib/server/db.js';

export interface RunnerInfo {
  slug: string;
  label: string;
  implemented: boolean;
  available: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
  detectedAt: string;
  config: RunnerConfig;
}

export const load: PageServerLoad = async (event) => {
  const db = getDb();

  // Runner detection/config is instance-wide config in the same domain as
  // retention/security policy (docs/permissions.md): gated to admin+ on
  // self-host, matching the corresponding API routes' requireRole('admin')
  // (default-runner/runner-config GET). `role` is undefined when auth is
  // off (hooks.server.ts never sets `locals.org` then), so `isAdmin` is true
  // in that case too - same no-op convention as `requireRole`, self-host
  // keeps full access. This loader used to be part of the General page's
  // Runners tab (#254 split it into its own route); see +page.svelte for the
  // matching "admin access required" fallback for a member.
  //
  // On cloud, a binary path, a version and a model id describe the
  // deployment, not any one tenant (#183): the per-org role is not the
  // right axis there (any user can self-create an org and become its
  // admin/owner), so the gate narrows to `isInstanceAdmin` instead of the
  // org role, same boundary `requireInstanceAdmin` enforces on the write
  // side. Still non-throwing - the rail hides this route entirely on cloud
  // (`settings/+layout.svelte`), but a direct hit shows the same "admin
  // access required" card a self-host member would see rather than a 403.
  const role = event.locals.org?.role;
  const orgIsAdmin = !role || role === 'admin' || role === 'owner';
  const isAdmin = isCloud() ? await isInstanceAdmin(event) : orgIsAdmin;

  let runners: RunnerInfo[] = [];
  let defaultRunner: string | null = null;

  if (isAdmin) {
    const detections = await detectAllRunners();
    const runnerConfigs = await loadRunnerConfigs(db);
    // Cloud edition offers only the runner it can dispatch (#410) - a local
    // backend never appears here to be set as instance default, matching
    // what the campaign/project forms offer.
    const allowed = allowedRunnerSlugs();
    runners = AGENT_RUNNER_META.filter((m) => allowed.includes(m.slug)).map((m) => ({
      slug: m.slug,
      label: m.label,
      implemented: m.implemented,
      available: m.implemented && detections[m.slug].available,
      version: detections[m.slug].version,
      path: detections[m.slug].path,
      error: m.implemented ? detections[m.slug].error : 'Runner adapter not implemented yet',
      detectedAt: detections[m.slug].detectedAt,
      config: runnerConfigs[m.slug],
    }));

    defaultRunner = await loadDefaultRunnerSlug(db);
  }

  return { runners, defaultRunner, isAdmin };
};
