import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { listUserOrganizations } from '@pitchbox/shared/orgs';
import { isInstanceAdmin } from '$lib/server/auth.js';
import { resolveEntitlements, isOrgReadOnly } from '@pitchbox/shared/plans';
import { currentEdition } from '@pitchbox/shared/edition';

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
 * `locale` (LOR-260) is `event.locals.locale`, already resolved by
 * `hooks.server.ts` - this is the mechanism's client call shape: every
 * descendant `+page.svelte`/`+layout.svelte` reads it from `$page.data.locale`
 * (or its own `data.locale` prop, since SvelteKit merges ancestor load data),
 * with no second resolution and no risk of disagreeing with the server. The
 * other call shape, for a route that needs the locale before rendering
 * anything, is `event.locals.locale` read directly inside that route's own
 * `+page.server.ts` load - see `web/tests/i18n.test.ts` for both asserted
 * against `resolveLocale` directly, and `docs/design/DECISIONS.md` D46 for
 * why the value never touches the path.
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
    locale: event.locals.locale,
    authOn: process.env.PITCHBOX_AUTH === 'on',
    signedIn: !!user,
    org: event.locals.org,
    orgs,
    isAdmin,
    isInstanceAdmin: await isInstanceAdmin(event),
    // #555: the settings rail's Billing entry - self-host has no plan
    // concept at all (shared/src/plans.ts's resolveEntitlements is
    // unlimited before it ever looks at Stripe or the catalogue there), so
    // the link is edition-gated the same way `organization` is auth-gated.
    isCloud: currentEdition() === 'cloud',
    billing,
  };
};
