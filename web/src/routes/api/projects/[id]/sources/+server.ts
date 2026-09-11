import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import {
  createProjectSource,
  listProjectSources,
  type ProjectSourceConfig,
} from '@pitchbox/shared/project-sources';
import { syncProjectSource } from '@pitchbox/shared/project-source-sync';
import { parseRepoUrl } from '@pitchbox/shared/github-sources';
import { assertSafeGitCloneUrl } from '@pitchbox/shared/project-extraction';
import { addWebsiteSource } from '@pitchbox/shared/website-source';
import { addMastodonAccountSource } from '@pitchbox/shared/mastodon-source';
import { addHackernewsAuthorSource } from '@pitchbox/shared/hackernews-source';
import {
  parseLinkedInPostIdentifier,
  parseLinkedInProfileIdentifier,
} from '@pitchbox/shared/platforms/linkedin';

// The kinds this endpoint accepts a plain `{ kind, value }` add for: every
// `PROJECT_SOURCE_KIND` that identifies a source by a URL/identifier alone.
// `folder` and `upload` are deliberately excluded - their `config.value` is a
// local path or an ephemeral server-side upload path with no meaning outside
// the extraction run that produced it, so they're still only added as a side
// effect of running an extraction (cli/src/commands/project.ts's
// recordExtractionSource, unchanged by #432) - never a bare POST here.
//
// `linkedin_company` is deliberately excluded too (#436): it is a real
// `PROJECT_SOURCE_KINDS` value, but nothing in this repo can fill one yet -
// spike #435 found the shape but the selector work for a company page is
// unstarted, and offering the button here would create a row that can only
// ever read "waiting for you to open it" forever, which is a worse
// experience than not offering it. Re-add it once
// `extension/src/content/shared/linkedin-dom.ts` gains a company-page
// reader and `linkedin-source-capture.ts` matches it.
const ADDABLE_KINDS = [
  'git',
  'website',
  'linkedin_profile',
  'linkedin_post',
  'mastodon_account',
  'hackernews_author',
] as const;

// `website`/`mastodon_account`/`hackernews_author` each need real parsing of
// the single `value` string (a URL split into instance+handle for Mastodon,
// a username-or-profile-URL for HN) into their own `config` shape - the
// generic `{ value }` row below only ever suits `git`, whose sync
// re-parses `config.value` itself (`syncGit`). `linkedin_post`/
// `linkedin_profile` also go through the generic path below, but with a
// `config.identifier` `buildSourceConfig` derives right here (see its own
// doc comment) rather than through a dedicated `add*Source`, since there is
// nothing to fetch at creation time for either kind. Routing the first three
// through their dedicated `add*Source` (below, in `POST`) keeps that parsing
// in one place (shared with the CLI/any other caller) instead of duplicating
// it here as a second, drifting copy.

const PostBody = z.object({
  kind: z.enum(ADDABLE_KINDS),
  value: z.string().min(1).max(2048),
});

function parseId(p: string | undefined): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * A `linkedin_post`/`linkedin_profile` source needs its identifier derived
 * and stored at creation time (#436): there is no server-side fetch of the
 * pasted URL to derive it from later (rule 4 of the compliance boundary), so
 * this is the one chance to turn whatever the human pasted into the exact
 * string `linkedin-source-capture.ts` will later read off the real page and
 * compare against. A value that cannot be parsed 400s rather than creating a
 * source with nothing a real page can ever match.
 */
function buildSourceConfig(
  kind: (typeof ADDABLE_KINDS)[number],
  value: string,
): { config: ProjectSourceConfig } | { error: string } {
  if (kind === 'linkedin_post') {
    const identifier = parseLinkedInPostIdentifier(value);
    if (!identifier) {
      return {
        error:
          'Paste a LinkedIn post URL (or its urn:li:activity: id) - could not find one in that value.',
      };
    }
    return { config: { value, identifier } };
  }
  if (kind === 'linkedin_profile') {
    const identifier = parseLinkedInProfileIdentifier(value);
    if (!identifier) {
      return {
        error:
          'Paste a LinkedIn profile URL (linkedin.com/in/<handle>) - could not find a handle in that value.',
      };
    }
    return { config: { value, identifier } };
  }
  if (kind === 'git') {
    // A GitHub shorthand (`owner/repo`) is the most natural thing to type
    // and the one thing `git clone` refuses, so it is normalised to the
    // https URL here rather than failing at run time, hours later, inside
    // an agent's first tool call. Anything `parseRepoUrl` does not
    // recognise (a self-hosted GitLab, an ssh remote) is stored as typed:
    // `syncGit` proves that one with `git ls-remote` instead.
    const parsed = parseRepoUrl(value);
    if (parsed.ok) return { config: { value: parsed.url } };
    // Not a GitHub URL: it has to be something `git` itself will accept,
    // or the row would sit there until a description run failed on it.
    try {
      assertSafeGitCloneUrl(value);
    } catch (e) {
      return { error: (e as Error).message };
    }
    return { config: { value } };
  }
  return { config: { value } };
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

  const built = buildSourceConfig(parsed.data.kind, parsed.data.value);
  if ('error' in built) throw error(400, built.error);

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

  const created = await createProjectSource(db, orgId, id, kind, built.config);
  if (!created) throw error(404, 'not_found');

  const synced = await syncProjectSource(db, orgId, created.id);
  return json({ source: synced?.source ?? created }, { status: 201 });
}
