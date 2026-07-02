import { json } from '@sveltejs/kit';
import { search } from '$lib/server/search.js';

export async function GET({ url }: { url: URL }) {
  const q = url.searchParams.get('q') ?? '';
  const results = await search(q);
  return json({ results });
}
