import type { PageServerLoad } from './$types';
import { requireRole } from '$lib/server/auth.js';

// Companion -> Work ("what you have shipped"), split out of the old
// three-card settings/companion page (LOR-178/LOR-179, docs/design/
// DECISIONS.md D35). No data loaded here: the repo list and the GitHub App
// install panel are both fetched client-side
// (/api/settings/github-sources, /api/settings/github-installations, each
// already gated on their own), same as the old combined page. This
// loader's only job is the page-level admin gate every companion route
// repeats on its own - see companion/+page.server.ts's comment for why it
// is not inherited from a layout instead.
export const load: PageServerLoad = async (event) => {
  requireRole(event, 'admin');
  return {};
};
