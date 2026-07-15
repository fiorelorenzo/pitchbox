import { json, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import {
  deleteOrganization,
  findOrgBySlug,
  getMemberRole,
  isOrgAdmin,
  renameOrg,
} from '@pitchbox/shared/orgs';

const NameBody = z.object({ name: z.string() });

// Rename the org (admin+). 404 (not 403) when the org is missing or the caller
// is not an admin, to avoid leaking org existence.
export async function PATCH(event: RequestEvent) {
  const user = event.locals.user;
  if (!user) return json({ error: 'unauthenticated' }, { status: 401 });
  const db = getDb();
  const org = await findOrgBySlug(db, event.params.slug as string);
  if (!org) return json({ error: 'not_found' }, { status: 404 });
  if (!(await isOrgAdmin(db, user.id, org.id)))
    return json({ error: 'not_found' }, { status: 404 });
  const parsed = NameBody.safeParse(await event.request.json().catch(() => ({})));
  if (!parsed.success) return json({ error: 'invalid_body' }, { status: 400 });
  const name = parsed.data.name.trim();
  if (name.length < 1 || name.length > 80) {
    return json({ error: 'Enter an organization name (up to 80 characters).' }, { status: 400 });
  }
  await renameOrg(db, org.id, name);
  return json({ ok: true, name });
}

// Delete the org (owner only). The `default` org is the auth-off fallback and
// cannot be deleted. FK cascades wipe the org's data.
export async function DELETE(event: RequestEvent) {
  const user = event.locals.user;
  if (!user) return json({ error: 'unauthenticated' }, { status: 401 });
  const slug = event.params.slug as string;
  if (slug === 'default') {
    return json({ error: 'The default organization cannot be deleted.' }, { status: 400 });
  }
  const db = getDb();
  const org = await findOrgBySlug(db, slug);
  if (!org) return json({ error: 'not_found' }, { status: 404 });
  const role = await getMemberRole(db, org.id, user.id);
  if (role !== 'owner') {
    // members/admins are 403 (they belong but can't); non-members are 404.
    return json(
      { error: role ? 'Only an owner can delete the organization.' : 'not_found' },
      { status: role ? 403 : 404 },
    );
  }
  await deleteOrganization(db, org.id);
  return json({ ok: true });
}
