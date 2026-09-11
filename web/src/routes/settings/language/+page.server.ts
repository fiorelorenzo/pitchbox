import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// 2026-09-12 UI/UX defects batch: the display-language picker folded into
// /settings/general as a card (LOR-262's picker still writes the same
// account-level locale through POST /api/auth/locale). Kept as a
// redirect-only stub, same pattern as /settings/status, because this route
// is deep-linked (AGENTS.md tells agents to point at the exact route rather
// than at bare /settings) - an old link still lands on the picker instead
// of 404ing.
export const load: PageServerLoad = async () => {
  throw redirect(307, '/settings/general');
};
