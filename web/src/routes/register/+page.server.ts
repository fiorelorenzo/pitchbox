import { redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { findValidInvite } from '@pitchbox/shared/orgs';
import type { PageServerLoad } from './$types';

// `/invite/<token>` redirects an unauthenticated visitor here with
// `?next=/invite/<token>` (web/src/routes/invite/[token]/+page.server.ts).
// Only that exact shape is trusted for an invite prefill/context lookup -
// anything else in `next` is just where the register form sends the browser
// after a successful POST.
const INVITE_NEXT = /^\/invite\/([^/?#]+)$/;

export const load: PageServerLoad = async (event) => {
  const authOn = process.env.PITCHBOX_AUTH === 'on';
  const rawNext = event.url.searchParams.get('next');
  const next = rawNext && rawNext.startsWith('/') ? rawNext : null;

  // Already signed in: nothing to register, go wherever `next` pointed (or
  // home). Mirrors the login page having no reason to show a form to a
  // caller who already has a session.
  if (event.locals.user) {
    throw redirect(302, next ?? '/');
  }

  let invite: { token: string; email: string | null; orgName: string | null } | null = null;
  const inviteMatch = authOn && next ? next.match(INVITE_NEXT) : null;
  if (inviteMatch) {
    const token = inviteMatch[1];
    const db = getDb();
    const found = await findValidInvite(db, token);
    if (found) {
      const [org] = await db
        .select({ name: schema.organizations.name })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, found.organizationId));
      invite = { token, email: found.email, orgName: org?.name ?? null };
    }
  }

  return { authOn, next, invite };
};
