import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { listUserOrganizations } from '@pitchbox/shared/orgs';

/**
 * Root layout loader. Exposes server-wide flags every page may need: `authOn`
 * (so the Sidebar can show Sign in vs Sign out), the active organization
 * (`event.locals.org`, set by the hook), and the caller's organizations (for
 * the org switcher). `orgs` is empty when signed out or auth is off.
 */
export const load: LayoutServerLoad = async (event) => {
  const user = event.locals.user;
  const orgs = user ? await listUserOrganizations(getDb(), user.id) : [];
  return {
    authOn: process.env.PITCHBOX_AUTH === 'on',
    org: event.locals.org,
    orgs,
  };
};
