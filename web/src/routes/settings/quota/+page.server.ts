import type { PageServerLoad } from './$types';
import { loadQuotaLimits, type QuotaLimits } from '@pitchbox/shared/quota';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../../lib/server/db.js';

export const load: PageServerLoad = async (event) => {
  const db = getDb();

  // Posting quota defaults are instance-wide config in the same domain as
  // retention/security policy (docs/permissions.md): gated to admin+,
  // matching the settings/quota GET route's requireRole('admin') (the
  // stricter requireInstanceAdmin its POST already enforces). `role` is
  // undefined when auth is off (hooks.server.ts never sets `locals.org`
  // then), so `isAdmin` is true in that case too - same no-op convention as
  // `requireRole`, self-host keeps full access. This loader used to be part
  // of the General page's Quota tab (#254 split it into its own route).
  const role = event.locals.org?.role;
  const isAdmin = !role || role === 'admin' || role === 'owner';

  const quota: Record<string, QuotaLimits> = {};
  if (isAdmin) {
    const platforms = await db
      .select({ slug: schema.platforms.slug })
      .from(schema.platforms)
      .where(eq(schema.platforms.enabled, true));
    for (const p of platforms) {
      quota[p.slug] = await loadQuotaLimits(db, p.slug);
    }
  }

  return { quota, isAdmin };
};
