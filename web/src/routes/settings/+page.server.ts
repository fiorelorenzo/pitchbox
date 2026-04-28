import { getExtensionToken, getExtensionTokenCreatedAt } from '@pitchbox/shared/extension-token';
import { loadQuotaLimits } from '@pitchbox/shared/quota';
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
  return {
    extension: {
      token: await getExtensionToken(),
      createdAt: await getExtensionTokenCreatedAt(),
      backendUrl: process.env.PITCHBOX_BACKEND_URL ?? 'http://127.0.0.1:5180',
    },
    quota,
  };
}
