import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { listProjects } from '@pitchbox/shared/projects';
import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { search } from '$lib/server/search.js';

export async function GET(event: RequestEvent) {
  const { url } = event;
  const q = url.searchParams.get('q') ?? '';
  const orgId = await requireOrgId(event);
  const projects = await listProjects(getDb(), { organizationId: orgId });
  const results = await search(
    q,
    projects.map((p) => p.id),
  );
  return json({ results });
}
