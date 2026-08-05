import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// #254: the General page (with Status/Runners/Integrations/Quota tabs) was
// flattened into seven top-level routes. `/settings` itself is no longer a
// page - it redirects to the first entry of the new rail. Status is always
// visible regardless of role (see settings/status/+page.svelte), so it is a
// safe landing spot for every old `/settings` link in the app.
export const load: PageServerLoad = async () => {
  throw redirect(307, '/settings/status');
};
