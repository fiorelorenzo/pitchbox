import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { createInvite, findOrgBySlug, isOrgAdmin } from '@pitchbox/shared/orgs';

const Body = z.object({
  email: z.string().email().optional(),
  role: z.enum(['owner', 'admin', 'member']).default('member'),
});

export async function POST(event) {
  const user = event.locals.user;
  if (!user) return json({ error: 'unauthenticated' }, { status: 401 });
  const slug = event.params.slug as string;
  const db = getDb();
  const org = await findOrgBySlug(db, slug);
  // 404 if org doesn't exist or the caller isn't an admin of it — avoid
  // leaking existence of orgs the user can't see.
  if (!org) return json({ error: 'not_found' }, { status: 404 });
  if (!(await isOrgAdmin(db, user.id, org.id))) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  const raw = await event.request.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const invite = await createInvite(db, {
    organizationId: org.id,
    role: parsed.data.role,
    email: parsed.data.email ?? null,
    createdByUserId: user.id,
  });
  const url = `${event.url.origin}/invite/${invite.token}`;
  return json({ token: invite.token, url, expiresAt: invite.expiresAt }, { status: 201 });
}
