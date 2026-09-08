import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { createProjectSource, listProjectSources } from '@pitchbox/shared/project-sources';
import { syncProjectSource } from '@pitchbox/shared/project-source-sync';
import { addWebsiteSource } from '@pitchbox/shared/website-source';
import { addMastodonAccountSource } from '@pitchbox/shared/mastodon-source';
import { addHackernewsAuthorSource } from '@pitchbox/shared/hackernews-source';

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
  'mastodon_account',
  'hackernews_author',
] as const;

// `website`/`mastodon_account`/`hackernews_author` each need real parsing of
// the single `value` string (a URL split into instance+handle for Mastodon,
// a username-or-profile-URL for HN) into their own `config` shape - the
// generic `{ value }` row below only ever suits `github`/`git`, whose sync
// re-parses `config.value` itself (`syncGithub`), and the still-unimplemented
// `linkedin_*` kinds, which don't read their config yet either way. Routing
// these three through their dedicated `add*Source` (below, in `POST`) keeps
// that parsing in one place (shared with the CLI/any other caller) instead
// of duplicating it here as a second, drifting copy.

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
  const { kind, value } = parsed.data;

  if (kind === 'website') {
    const result = await addWebsiteSource(db, orgId, id, value);
    if (!result.ok) {
      if (result.code === 'not_found') throw error(404, 'not_found');
      throw error(400, result.reason);
    }
    return json({ source: result.source }, { status: 201 });
  }
  if (kind === 'mastodon_account') {
    const result = await addMastodonAccountSource(db, orgId, id, value);
    if (!result.ok) {
      if (result.code === 'not_found') throw error(404, 'not_found');
      throw error(400, result.reason);
    }
    return json({ source: result.source }, { status: 201 });
  }
  if (kind === 'hackernews_author') {
    const result = await addHackernewsAuthorSource(db, orgId, id, value);
    if (!result.ok) {
      if (result.code === 'not_found') throw error(404, 'not_found');
      throw error(400, result.reason);
    }
    return json({ source: result.source }, { status: 201 });
  }

  const created = await createProjectSource(db, orgId, id, kind, { value });
  if (!created) throw error(404, 'not_found');

  const synced = await syncProjectSource(db, orgId, created.id);
  return json({ source: synced?.source ?? created }, { status: 201 });
}
