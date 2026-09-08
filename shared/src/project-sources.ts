// A project's set of sources (#431/#398): create, list, update and delete
// `project_sources` rows. Every function takes the caller's organizationId
// and checks it here - through `projectBelongsToOrg` - rather than leaving
// that check to every call site, the same contract `github-sources.ts`
// follows for its own org-scoped table.
//
// A miss (wrong org, or an id that does not exist) returns `null`/`false`/an
// empty list rather than throwing, so a caller turns it into a 404 and a
// probe against another org's id learns nothing - mirrors
// `removeGithubSource` and every `*BelongsToOrg` helper in `orgs.ts`.

import { and, asc, eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { projectBelongsToOrg } from './orgs.js';

/**
 * Today's extraction inputs (`folder`, `git`, `upload`) and the GitHub cache
 * (`github`), plus `website` (#433), the three LinkedIn shapes #435 is
 * spiking (a company page, a profile, a single post), and two adapters this
 * repo already talks to reused read-only (#437): `mastodon_account` (a
 * Mastodon account's own public posts, no credential) and
 * `hackernews_author` (an HN user's own submissions, no credential). A kind
 * nobody implements yet is a valid value here; siblings import this union
 * rather than keeping their own copy of the list.
 */
export const PROJECT_SOURCE_KINDS = [
  'folder',
  'git',
  'upload',
  'github',
  'website',
  'linkedin_company',
  'linkedin_profile',
  'linkedin_post',
  'mastodon_account',
  'hackernews_author',
] as const;

export type ProjectSourceKind = (typeof PROJECT_SOURCE_KINDS)[number];

export type ProjectSourceRow = typeof schema.projectSources.$inferSelect;

/** Kind-specific input: e.g. `{ value: '/path/to/folder' }` for `folder`/`git`/
 * `upload`, `{ owner, repo, url }` for `github`, `{ url }` for `website`. */
export type ProjectSourceConfig = Record<string, unknown>;

/** Kind-specific cached read: what the last successful fetch produced. */
export type ProjectSourceOutput = Record<string, unknown>;

export interface ProjectSourcePatch {
  config?: ProjectSourceConfig;
  output?: ProjectSourceOutput | null;
  active?: boolean;
  fetchedAt?: Date | null;
  fetchError?: string | null;
}

/**
 * Adds a source to a project. Returns null when `projectId` does not belong
 * to `organizationId` (or does not exist) - the caller turns that into a 404.
 */
export async function createProjectSource(
  db: Db,
  organizationId: number,
  projectId: number,
  kind: ProjectSourceKind,
  config: ProjectSourceConfig = {},
): Promise<ProjectSourceRow | null> {
  if (!(await projectBelongsToOrg(db, projectId, organizationId))) return null;
  const [row] = await db
    .insert(schema.projectSources)
    .values({ projectId, kind, config })
    .returning();
  return row ?? null;
}

/**
 * All of a project's sources, oldest-added first. Returns an empty list when
 * `projectId` does not belong to `organizationId` (or does not exist) -
 * indistinguishable from a project with no sources yet, on purpose.
 */
export async function listProjectSources(
  db: Db,
  organizationId: number,
  projectId: number,
): Promise<ProjectSourceRow[]> {
  if (!(await projectBelongsToOrg(db, projectId, organizationId))) return [];
  return db
    .select()
    .from(schema.projectSources)
    .where(eq(schema.projectSources.projectId, projectId))
    .orderBy(asc(schema.projectSources.id));
}

/** Resolves a source row's project id, or null if it does not exist. */
async function getSourceProjectId(db: Db, id: number): Promise<number | null> {
  const [row] = await db
    .select({ projectId: schema.projectSources.projectId })
    .from(schema.projectSources)
    .where(eq(schema.projectSources.id, id));
  return row?.projectId ?? null;
}

/**
 * A single source, scoped to the caller's organization. Returns null when
 * `id` does not exist or its project does not belong to `organizationId` -
 * same "wrong org looks identical to missing" contract as the rest of this
 * module. Backs the sync dispatcher (project-source-sync.ts) and the
 * `GET .../sources/[sourceId]` read.
 */
export async function getProjectSource(
  db: Db,
  organizationId: number,
  id: number,
): Promise<ProjectSourceRow | null> {
  const projectId = await getSourceProjectId(db, id);
  if (projectId === null) return null;
  if (!(await projectBelongsToOrg(db, projectId, organizationId))) return null;
  const [row] = await db
    .select()
    .from(schema.projectSources)
    .where(eq(schema.projectSources.id, id));
  return row ?? null;
}

/**
 * Updates a source's config, cached output or fetch state. Returns null when
 * `id` does not exist or its project does not belong to `organizationId`.
 */
export async function updateProjectSource(
  db: Db,
  organizationId: number,
  id: number,
  patch: ProjectSourcePatch,
): Promise<ProjectSourceRow | null> {
  const projectId = await getSourceProjectId(db, id);
  if (projectId === null) return null;
  if (!(await projectBelongsToOrg(db, projectId, organizationId))) return null;

  const [row] = await db
    .update(schema.projectSources)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.projectSources.id, id))
    .returning();
  return row ?? null;
}

/**
 * Deletes a source. Returns false when `id` does not exist or its project
 * does not belong to `organizationId`.
 */
export async function deleteProjectSource(
  db: Db,
  organizationId: number,
  id: number,
): Promise<boolean> {
  const projectId = await getSourceProjectId(db, id);
  if (projectId === null) return false;
  if (!(await projectBelongsToOrg(db, projectId, organizationId))) return false;

  const deleted = await db
    .delete(schema.projectSources)
    .where(and(eq(schema.projectSources.id, id), eq(schema.projectSources.projectId, projectId)))
    .returning({ id: schema.projectSources.id });
  return deleted.length > 0;
}
