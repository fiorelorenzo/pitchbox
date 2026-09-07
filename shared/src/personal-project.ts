// The `personal` project: where a suggestion that is not about a product goes.
//
// Decided 2026-09-07. The in-page companion writes as a person, on any subject,
// but `drafts.project_id` and `drafts.account_id` are both NOT NULL, so an
// accepted suggestion has to belong to a project. Putting a personal comment
// under a product's project makes that product's analytics count outreach it
// never received, which quietly ruins the one number the project view exists to
// show. So every organization gets one project that IS the operator.
//
// Created at organization creation, backfilled for existing organizations by
// `migrations/0015_personal_project.sql`, and re-created here if it is ever
// missing. Creating it inside the assist request would put a write on the hot
// path and race two devices asking for a suggestion at the same moment; doing
// it up front is deterministic, and the `ON CONFLICT` below is what makes the
// safety net idempotent rather than a second race.

import { and, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { schema } from './db/client.js';

// The loose handle `orgs.ts` and `auth.ts` already use, rather than the strict
// `Db` from `db/client.ts`: this is called from an organization-creation path
// that may be holding a transaction handle, and from `seed-core.ts`, and the
// strict type admits neither.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

export const PERSONAL_PROJECT_SLUG = 'personal';
export const PERSONAL_PROJECT_NAME = 'Personal';
export const PERSONAL_PROJECT_DESCRIPTION =
  "Your own voice. The in-page assistant writes as this project when a suggestion is not about one of your products, and its drafts stay out of the other projects' numbers.";

/**
 * Returns the organization's personal project id, creating the row if it is
 * absent. Safe to call concurrently: the insert defers to
 * `projects_org_slug_unique` and then reads the winner.
 */
export async function ensurePersonalProject(db: Db, organizationId: number): Promise<number> {
  const existing = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.organizationId, organizationId),
        eq(schema.projects.slug, PERSONAL_PROJECT_SLUG),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  const inserted = await db
    .insert(schema.projects)
    .values({
      organizationId,
      slug: PERSONAL_PROJECT_SLUG,
      name: PERSONAL_PROJECT_NAME,
      description: PERSONAL_PROJECT_DESCRIPTION,
    })
    .onConflictDoNothing({
      target: [schema.projects.organizationId, schema.projects.slug],
    })
    .returning({ id: schema.projects.id });
  if (inserted[0]) return inserted[0].id;

  // Lost the insert race: the row exists now, written by whoever won.
  const [row] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.organizationId, organizationId),
        eq(schema.projects.slug, PERSONAL_PROJECT_SLUG),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`personal project missing for organization ${organizationId}`);
  return row.id;
}
