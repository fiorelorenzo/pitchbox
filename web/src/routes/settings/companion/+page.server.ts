import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// LOR-178/LOR-179 (docs/design/DECISIONS.md D35): the companion moved out
// of Settings into its own top-level sidebar group at /companion. This
// route keeps a redirect rather than disappearing - a stray bookmark or an
// old browser history entry still lands here even though the GitHub App
// install round trip (api/integrations/github/setup/+server.ts's BACK
// constant) no longer sends anyone through it - same pattern `/settings`
// and `/settings/status` use for their own retired names.
export const load: PageServerLoad = async () => {
  throw redirect(307, '/companion');
};
