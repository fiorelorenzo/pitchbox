// Matches a pending `linkedin_post`/`linkedin_profile` project source
// against the identifier a content script read directly off a real LinkedIn
// page (#436, spike #435's "Plane 3"). Two steps, mirroring
// POST /api/extension/observations' own precedent:
// `findPendingProjectSourceMatch` answers a cheap read before anything is
// read from the DOM; `fillProjectSourceFromCapture` re-validates and writes
// the row a real capture posts. Neither ever fetches linkedin.com - both
// only ever compare a string the client already read against a string
// `shared/src/platforms/linkedin/index.ts` derived from whatever URL the
// human pasted when the source was created.
//
// `identifier` lives in `project_sources.config.identifier` (jsonb), set
// once at creation time (`web/src/routes/api/projects/[id]/sources/+server.ts`)
// rather than in a column of its own: `config` is already the kind-specific
// input `project-sources.ts` documents, and a second table just for this
// lookup would duplicate the org-scoping join every other read in that
// module already does through `projects.organization_id`.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import {
  getProjectSource,
  updateProjectSource,
  type ProjectSourceOutput,
  type ProjectSourceRow,
} from './project-sources.js';

export type LinkedInSourceMatchKind = 'linkedin_post' | 'linkedin_profile';

export type ProjectSourceMatch = { id: number; projectId: number };

/**
 * The first pending (`output IS NULL`) source of `kind` in `organizationId`
 * whose stored `config.identifier` equals `identifier`, or null. A source
 * that already has output is never matched again - a refresh needs the
 * dashboard to flip it back to pending first (`syncProjectSource`'s
 * `linkedin_post`/`linkedin_profile` branch), which is what makes "refresh
 * needs a second visit" true rather than just documented.
 */
export async function findPendingProjectSourceMatch(
  db: Db,
  organizationId: number,
  kind: LinkedInSourceMatchKind,
  identifier: string,
): Promise<ProjectSourceMatch | null> {
  const [row] = await db
    .select({ id: schema.projectSources.id, projectId: schema.projectSources.projectId })
    .from(schema.projectSources)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectSources.projectId))
    .where(
      and(
        eq(schema.projects.organizationId, organizationId),
        eq(schema.projectSources.kind, kind),
        isNull(schema.projectSources.output),
        sql`${schema.projectSources.config} ->> 'identifier' = ${identifier}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Fills a pending source with a real capture. Re-validates everything the
 * earlier match already checked, plus that the row is still pending, since
 * the two calls are not atomic: the source can be deleted, refreshed back to
 * pending, or already filled by another tab's content script in between.
 * Returns null on any mismatch - indistinguishable to a caller from "no
 * longer applies", the same posture `getProjectSource` already takes for a
 * wrong org or a missing id. Never throws.
 */
export async function fillProjectSourceFromCapture(
  db: Db,
  organizationId: number,
  sourceId: number,
  kind: LinkedInSourceMatchKind,
  identifier: string,
  output: ProjectSourceOutput,
): Promise<ProjectSourceRow | null> {
  const source = await getProjectSource(db, organizationId, sourceId);
  if (!source || source.kind !== kind || source.output !== null) return null;
  const config = source.config as Record<string, unknown> | null;
  if (config?.identifier !== identifier) return null;
  return updateProjectSource(db, organizationId, sourceId, {
    output,
    fetchedAt: new Date(),
    fetchError: null,
  });
}
