import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// #186: this route was the settings landing page (labelled Status) before it
// was renamed to General - it was never actually status-specific, daemon
// health is one card on it (#254 note in docs/permissions.md). Kept as a
// redirect because it is deep-linked (AGENTS.md tells agents to point at the
// exact route rather than at bare `/settings`), so an old link still lands
// on the right page instead of 404ing.
export const load: PageServerLoad = async () => {
  throw redirect(307, '/settings/general');
};
