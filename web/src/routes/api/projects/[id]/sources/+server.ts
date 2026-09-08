import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { createProjectSource, listProjectSources } from '@pitchbox/shared/project-sources';
import { syncProjectSource } from '@pitchbox/shared/project-source-sync';

// The kinds this endpoint accepts a plain `{ kind, value }` add for: every
// `PROJECT_SOURCE_KIND` that identifies a source by a URL/identifier alone.
// `folder` and `upload` are deliberately excluded - their `config.value` is a
// local path or an ephemeral server-side upload path with no meaning outside
// the extraction run that produced it, so they're still only added as a side
// effect of running an extraction (cli/src/commands/project.ts's
// recordExtractionSource, unchanged by #432) - never a bare POST here.
const ADDABLE_KINDS = [
  'git',
  'github',
  'website',
  'linkedin_company',
  'linkedin_profile',
  'linkedin_post',
] as const;

const PostBody = z.object({
  kind: z.enum(ADDABLE_KINDS),
  value: z.string().min(1).max(2048),
});

function parseId(p: string | undefined): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(event: RequestEvent) {
  const { params } = event;
  const id = parseId(params.id);
  if (!id) throw error(400, 'invalid_id');
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const sources = await listProjectSources(getDb(), orgId, id);
  return json({ sources });
}

// Admin-gated like `projects/[id]/accounts` POST: sources feed the
// description an agent uses to ground drafts, the same trust level as
// connecting an account. Creates the row, then syncs it inline so the
// caller sees real fetch state (success, or a fetch_error explaining why)
// on the same response - same convention as `addGithubSource`.
export async function POST(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) throw error(400, 'invalid_id');
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  requireRole(event, 'admin');

  const raw = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    throw error(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  const db = getDb();
  const created = await createProjectSource(db, orgId, id, parsed.data.kind, {
    value: parsed.data.value,
  });
  if (!created) throw error(404, 'not_found');

  const synced = await syncProjectSource(db, orgId, created.id);
  return json({ source: synced?.source ?? created }, { status: 201 });
}
