import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { listUserOrganizations } from '@pitchbox/shared/orgs';
import { isInstanceAdmin } from '$lib/server/auth.js';
import { resolveEntitlements, isOrgReadOnly } from '@pitchbox/shared/plans';

/**
 * Root layout loader. Exposes server-wide flags every page may need: `authOn`
 * (so the Sidebar can show Sign out only when it would actually work),
 * `signedIn` (so the layout can keep the app shell off the unauthenticated
 * routes), the active organization (`event.locals.org`, set by the hook), the
 * caller's organizations (for the org switcher), `isAdmin` (so the UI can
 * hide admin-only controls), and `isInstanceAdmin` (so the settings rail can
 * show the instance-admin area only to the operator of the deployment - see
 * `requireInstanceAdmin`/`isInstanceAdmin`, docs/permissions.md "Instance
 * admin"). `orgs` is empty when signed out or auth is off.
 *
 * `billing` (#554) is the one entitlements read every page pays, gated on
 * having an active org at all (self-host with auth off never does, and
 * `resolveEntitlements` itself short-circuits to unlimited there anyway) and
 * on the org actually carrying a grace deadline - the common case for a
 * paying-and-current org is `null`, no further query. `BillingGraceBanner`
 * is the one reader; the notification landing in the bell icon at the same
 * moment is the webhook's own `notify` call (shared/src/billing/webhook.ts).
 */
export const load: LayoutServerLoad = async (event) => {
  const user = event.locals.user;
  const orgs = user ? await listUserOrganizations(getDb(), user.id) : [];
  const role = event.locals.org?.role;
  const isAdmin = !event.locals.org || role === 'owner' || role === 'admin';

  let billing: { graceEndsAt: string; readOnly: boolean } | null = null;
  if (event.locals.org) {
    const entitlements = await resolveEntitlements(getDb(), event.locals.org.id);
    if (entitlements.graceEndsAt) {
      billing = {
        graceEndsAt: entitlements.graceEndsAt.toISOString(),
        readOnly: isOrgReadOnly(entitlements),
      };
    }
  }

  return {
    authOn: process.env.PITCHBOX_AUTH === 'on',
    signedIn: !!user,
    org: event.locals.org,
    orgs,
    isAdmin,
    isInstanceAdmin: await isInstanceAdmin(event),
    billing,
  };
};
