import { getExtensionToken, getExtensionTokenCreatedAt } from '@pitchbox/shared/extension-token';
import { loadQuotaLimits } from '@pitchbox/shared/quota';
import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
import { detectAllRunners } from '@pitchbox/shared/agents/detect';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

export async function load() {
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
  const runners = AGENT_RUNNER_META.map((m) => ({
    slug: m.slug,
    label: m.label,
    implemented: m.implemented,
    available: m.implemented && detections[m.slug].available,
    version: detections[m.slug].version,
    path: detections[m.slug].path,
    error: m.implemented ? detections[m.slug].error : 'Runner adapter not implemented yet',
    detectedAt: detections[m.slug].detectedAt,
  }));

  return {
    extension: {
      token: await getExtensionToken(),
      createdAt: await getExtensionTokenCreatedAt(),
      backendUrl: process.env.PITCHBOX_BACKEND_URL ?? 'http://127.0.0.1:5180',
    },
    quota,
    runners,
  };
}
