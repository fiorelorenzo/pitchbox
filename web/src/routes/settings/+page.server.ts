import { loadQuotaLimits } from '@pitchbox/shared/quota';
import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
import { detectAllRunners } from '@pitchbox/shared/agents/detect';
import { loadRunnerConfigs } from '@pitchbox/shared/agents/config';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

export async function load({ url }) {
  const db = getDb();
  const platforms = await db
    .select({ slug: schema.platforms.slug })
    .from(schema.platforms)
    .where(eq(schema.platforms.enabled, true));
  const quota: Record<string, Awaited<ReturnType<typeof loadQuotaLimits>>> = {};
  for (const p of platforms) {
    quota[p.slug] = await loadQuotaLimits(db, p.slug);
  }

  const detections = await detectAllRunners();
  const runnerConfigs = await loadRunnerConfigs(db);
  const runners = AGENT_RUNNER_META.map((m) => ({
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

  const [defaultRunnerRow] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, 'default_runner'));
  const defaultRunner = (defaultRunnerRow?.value as { slug?: string })?.slug ?? null;

  return {
    extension: {
      // What the user should point the extension at: an explicit override if
      // set, otherwise this dashboard's own public origin (which is exactly
      // the backend the extension auto-pairs against and what you type into
      // its "Add connection" form). See docs/extension-connection-design.md.
      backendUrl: process.env.PITCHBOX_BACKEND_URL ?? url.origin,
    },
    quota,
    runners,
    defaultRunner,
  };
}
