import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// #254: the General page (with Status/Runners/Integrations/Quota tabs) was
// flattened into seven top-level routes. `/settings` itself is no longer a
// page - it redirects to the first entry of the new rail. General is always
// visible regardless of role (see settings/general/+page.svelte), so it is a
// safe landing spot for every old `/settings` link in the app. `/settings/
// status` (#186's old route name) also redirects here rather than 404ing.
export const load: PageServerLoad = async () => {
  throw redirect(307, '/settings/general');
};
