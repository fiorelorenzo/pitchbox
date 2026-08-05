import { redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

// #252: Contacts merged into /people as the "All contacts" tab. This route
// stays only so old links and bookmarks keep resolving - every query param
// (platform, q, format, ...) rides along unchanged, `tab=contacts` is
// added so the merged page lands on the right tab. The co-located
// +server.ts GET handler is untouched: SvelteKit routes requests that
// don't accept text/html there instead of here, so the "Load more" fetch
// this page's tab still uses keeps working without duplicating the query.
export async function load(event: RequestEvent) {
  const url = new URL(event.url);
  url.pathname = '/people';
  url.searchParams.set('tab', 'contacts');
  throw redirect(307, url.pathname + url.search);
}
