import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { acceptInvite, findValidInvite } from '@pitchbox/shared/orgs';
import type { Actions, PageServerLoad } from './$types';

// The invite `load` runs on a plain GET navigation, which an attacker can
// trigger from a third-party page (img/iframe embed) without the victim's
// intent. It must therefore only preview the invite, never accept it -
// acceptance happens in the `default` form action below, which only ever
// runs on an explicit POST submitted by the user.
export const load: PageServerLoad = async (event) => {
  const token = event.params.token as string;
  const db = getDb();
  const invite = await findValidInvite(db, token);
  if (!invite) {
    return { ok: false as const, reason: 'invalid_or_expired' as const };
  }
  if (!event.locals.user) {
    const next = encodeURIComponent(event.url.pathname);
    throw redirect(302, `/login?next=${next}`);
  }
  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, invite.organizationId));
  const [inviter] = invite.createdByUserId
    ? await db
        .select({ username: schema.users.username })
        .from(schema.users)
        .where(eq(schema.users.id, invite.createdByUserId))
    : [];
  return {
    ok: true as const,
    org: org ? { name: org.name } : null,
    inviter: inviter ? { username: inviter.username } : null,
  };
};

export const actions: Actions = {
  default: async (event) => {
    const token = event.params.token as string;
    const db = getDb();
    if (!event.locals.user) {
      const next = encodeURIComponent(event.url.pathname);
      throw redirect(302, `/login?next=${next}`);
    }
    const accepted = await acceptInvite(db, token, event.locals.user.id);
    if (!accepted) {
      return fail(400, { ok: false as const, reason: 'invalid_or_expired' as const });
    }
    throw redirect(302, '/');
  },
};
