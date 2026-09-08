import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { listUserOrganizations } from '@pitchbox/shared/orgs';
import { isInstanceAdmin } from '$lib/server/auth.js';

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
 */
export const load: LayoutServerLoad = async (event) => {
  const user = event.locals.user;
  const orgs = user ? await listUserOrganizations(getDb(), user.id) : [];
  const role = event.locals.org?.role;
  const isAdmin = !event.locals.org || role === 'owner' || role === 'admin';
  return {
    authOn: process.env.PITCHBOX_AUTH === 'on',
    signedIn: !!user,
    org: event.locals.org,
    orgs,
    isAdmin,
    isInstanceAdmin: await isInstanceAdmin(event),
  };
};
