import { error } from '@sveltejs/kit';
import { streamCsv, type ResourceName } from '$lib/server/export-csv.js';

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
  return streamCsv(resource, url.searchParams);
}
