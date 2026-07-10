import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { streamCsv, type ResourceName } from '$lib/server/export-csv.js';
import { listProjects } from '@pitchbox/shared/projects';
import { resolveOrgId } from '$lib/server/auth.js';

const SUPPORTED: ResourceName[] = ['drafts', 'contacts', 'conversations'];

export async function GET(event: import('@sveltejs/kit').RequestEvent): Promise<Response> {
  const { params, url } = event;
  const resource = params.resource as ResourceName | undefined;
  if (!resource || !SUPPORTED.includes(resource)) {
    throw error(404, `Unknown export resource: ${resource ?? '(missing)'}`);
  }
  const format = url.searchParams.get('format') ?? 'csv';
  if (format !== 'csv') {
    throw error(400, `Unsupported format: ${format}`);
  }
  const orgId = await resolveOrgId(event);
  const projects = await listProjects(getDb(), { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);
  return streamCsv(resource, url.searchParams, projectIds);
}
