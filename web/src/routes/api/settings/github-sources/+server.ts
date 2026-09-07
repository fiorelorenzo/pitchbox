import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { addGithubSource, listGithubSources } from '@pitchbox/shared/github-sources';

// The public GitHub repositories the companion can talk about (Lorenzo's
// decision, 2026-09-07: by URL, no credential - the optional GitHub App for
// private repos is a later issue). GET is member-level, matching the other
// read-only settings lists (docs/permissions.md); POST does the parse,
// insert, and first fetch inline so the caller always gets back a source
// that already has data or already has its own error, and is admin-gated
// like the rest of Settings' structural config. Both scope every query by
// requireOrgId, never by anything the request body supplies.

const AddBody = z.object({ url: z.string().min(1) });

export async function GET(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  const sources = await listGithubSources(getDb(), orgId);
  return json({ sources });
}

export async function POST(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');

  const parsed = AddBody.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) {
    throw error(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  const result = await addGithubSource(getDb(), orgId, parsed.data.url);
  if (!result.ok) {
    // invalid_url: the input wasn't a GitHub URL or owner/repo shorthand.
    // duplicate: this owner/repo is already in the org's sources.
    throw error(result.code === 'duplicate' ? 409 : 400, result.reason);
  }
  return json({ source: result.source }, { status: 201 });
}
