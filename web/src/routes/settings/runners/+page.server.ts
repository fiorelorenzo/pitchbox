import type { PageServerLoad } from './$types';
import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
import { detectAllRunners } from '@pitchbox/shared/agents/detect';
import {
  loadRunnerConfigs,
  loadDefaultRunnerSlug,
  type RunnerConfig,
} from '@pitchbox/shared/agents/config';
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
  // retention/security policy (docs/permissions.md): gated to admin+,
  // matching the corresponding API routes' requireRole('admin')
  // (default-runner/runner-config GET). `role` is undefined when auth is
  // off (hooks.server.ts never sets `locals.org` then), so `isAdmin` is true
  // in that case too - same no-op convention as `requireRole`, self-host
  // keeps full access. This loader used to be part of the General page's
  // Runners tab (#254 split it into its own route); see +page.svelte for the
  // matching "admin access required" fallback for a member.
  const role = event.locals.org?.role;
  const isAdmin = !role || role === 'admin' || role === 'owner';

  let runners: RunnerInfo[] = [];
  let defaultRunner: string | null = null;

  if (isAdmin) {
    const detections = await detectAllRunners();
    const runnerConfigs = await loadRunnerConfigs(db);
    runners = AGENT_RUNNER_META.map((m) => ({
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
