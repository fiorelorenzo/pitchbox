import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';

const KINDS = ['subreddit', 'user', 'keyword'] as const;
type Kind = (typeof KINDS)[number];

const SCOPES = ['global', 'project'] as const;
type Scope = (typeof SCOPES)[number];

type CreateBody = {
  platformId?: number;
  kind?: string;
  value?: string;
  reason?: string | null;
  scope?: string;
  projectId?: number | null;
};

export async function POST(event: RequestEvent) {
  const { request } = event;
  const body = (await request.json()) as CreateBody;

  if (!body.platformId || !Number.isInteger(body.platformId)) {
    throw error(400, 'platformId required');
  }
  if (!body.kind || !KINDS.includes(body.kind as Kind)) {
    throw error(400, `kind must be one of ${KINDS.join(', ')}`);
  }
  if (!body.value || body.value.trim().length === 0) {
    throw error(400, 'value required');
  }
  const scope = (body.scope ?? 'global') as Scope;
  if (!SCOPES.includes(scope)) throw error(400, 'invalid scope');
  if (scope === 'project' && !body.projectId) {
    throw error(400, 'projectId required when scope=project');
  }

  if (scope === 'project' && body.projectId) {
    const orgId = await requireOrgId(event);
    if (!(await projectBelongsToOrg(getDb(), body.projectId, orgId))) {
      throw error(404, 'not_found');
    }
  }

  const db = getDb();
  const [inserted] = await db
    .insert(schema.blocklist)
    .values({
      platformId: body.platformId,
      kind: body.kind,
      value: body.value.trim(),
      reason: body.reason ?? null,
      scope,
      projectId: scope === 'project' ? (body.projectId ?? null) : null,
    })
    .returning();

  return json({ ok: true, entry: inserted });
}
