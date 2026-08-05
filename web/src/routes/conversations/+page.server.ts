import { redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

// #252: Conversations merged into /people as the "Threads" tab, which is
// also the default tab (no `tab` param) - so this redirect preserves every
// other query param (filter, kind, q, format, ...) but never adds `tab`
// itself, keeping the canonical URL clean. The co-located +server.ts GET
// handler is untouched: SvelteKit routes requests that don't accept
// text/html there instead of here, so the "Load more" fetch this page's
// tab still uses keeps working without duplicating the query.
export async function load(event: RequestEvent) {
  const url = new URL(event.url);
  url.pathname = '/people';
  url.searchParams.delete('tab');
  throw redirect(307, url.pathname + url.search);
}
