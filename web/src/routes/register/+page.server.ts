import { redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { findValidInvite } from '@pitchbox/shared/orgs';
import { isPlanId, PLAN_CATALOGUE, type PlanId } from '@pitchbox/shared/plans';
import {
  loadRegistrationPolicy,
  DEFAULT_REGISTRATION_POLICY,
  type RegistrationPolicy,
} from '@pitchbox/shared/registration-policy';
import type { PageServerLoad } from './$types';

// `/invite/<token>` redirects an unauthenticated visitor here with
// `?next=/invite/<token>` (web/src/routes/invite/[token]/+page.server.ts).
// Only that exact shape is trusted for an invite prefill/context lookup -
// anything else in `next` is just where the register form sends the browser
// after a successful POST.
const INVITE_NEXT = /^\/invite\/([^/?#]+)$/;

/** `?plan=growth` from the pricing page's call to action (#558): the only
 * carrier a self-serve signup has for "which plan did they mean to buy",
 * since the account and its org do not exist yet to hold that on a row.
 * `free` is not a plan worth preselecting - a fresh org already starts
 * there - so only a paid id is ever returned. `?interval=year` follows the
 * pricing page's own monthly/annual toggle; anything else defaults to
 * monthly. An invited signup ignores both: they are joining an existing
 * org whose plan an admin already chose, not buying one of their own. */
function selectedPlanFromUrl(
  url: URL,
  hasInvite: boolean,
): { plan: PlanId; interval: 'month' | 'year' } | null {
  if (hasInvite) return null;
  const raw = url.searchParams.get('plan');
  if (!raw || !isPlanId(raw) || raw === 'free') return null;
  const interval = url.searchParams.get('interval') === 'year' ? 'year' : 'month';
  return { plan: raw, interval };
}

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
  let policy: RegistrationPolicy = DEFAULT_REGISTRATION_POLICY;
  if (authOn) {
    const db = getDb();
    policy = await loadRegistrationPolicy(db);
    const inviteMatch = next ? next.match(INVITE_NEXT) : null;
    if (inviteMatch) {
      const token = inviteMatch[1];
      const found = await findValidInvite(db, token);
      if (found) {
        const [org] = await db
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, found.organizationId));
        invite = { token, email: found.email, orgName: org?.name ?? null };
      }
    }
  }

  // #505: the same three-state policy the route enforces server-side, read
  // here so the page never offers a form that POST /api/auth/register would
  // only refuse - a hidden/disabled form is presentation, not the gate, but
  // showing one that cannot possibly succeed is worse than showing nothing.
  const canRegister = policy === 'open' || (policy === 'invite' && invite !== null);

  const selected = selectedPlanFromUrl(event.url, invite !== null);
  const selectedPlanName = selected ? PLAN_CATALOGUE[selected.plan].name : null;

  return {
    authOn,
    next,
    invite,
    policy,
    canRegister,
    selectedPlan: selected?.plan ?? null,
    selectedInterval: selected?.interval ?? null,
    selectedPlanName,
  };
};
