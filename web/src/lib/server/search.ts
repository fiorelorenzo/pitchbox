import { and, ilike, inArray, or } from 'drizzle-orm';
import { getDb, schema } from './db.js';

export type SearchResult = {
  kind: 'draft' | 'contact' | 'campaign' | 'project';
  id: number | string;
  label: string;
  sublabel?: string;
  href: string;
};

/**
 * Full-text-ish search scoped to the given projects. `projectIds` must be the
 * active org's project ids (see `requireOrgId` + `listProjects` in the caller) -
 * the drafts/campaigns/projects legs never cross that boundary. `contact_history`
 * stays global by design (accepted residual, see
 * docs/organization-isolation-design.md) since contact dedup is shared across
 * orgs. `inArray(x, [])` is a SQL error, so an empty `projectIds` short-circuits
 * those three legs to empty results instead of querying.
 */
export async function search(q: string, projectIds: number[]): Promise<SearchResult[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const db = getDb();
  const like = `%${trimmed}%`;
  const hasProjects = projectIds.length > 0;

  const [draftRows, contactRows, campaignRows, projectRows] = await Promise.all([
    hasProjects
      ? db
          .select({
            id: schema.drafts.id,
            targetUser: schema.drafts.targetUser,
            title: schema.drafts.title,
            body: schema.drafts.body,
          })
          .from(schema.drafts)
          .where(
            and(
              inArray(schema.drafts.projectId, projectIds),
              or(ilike(schema.drafts.body, like), ilike(schema.drafts.targetUser, like)),
            ),
          )
          .limit(5)
      : [],
    db
      .select({
        id: schema.contactHistory.id,
        targetUser: schema.contactHistory.targetUser,
        accountHandle: schema.contactHistory.accountHandle,
      })
      .from(schema.contactHistory)
      .where(ilike(schema.contactHistory.targetUser, like))
      .limit(5),
    hasProjects
      ? db
          .select({ id: schema.campaigns.id, name: schema.campaigns.name })
          .from(schema.campaigns)
          .where(
            and(
              inArray(schema.campaigns.projectId, projectIds),
              ilike(schema.campaigns.name, like),
            ),
          )
          .limit(5)
      : [],
    hasProjects
      ? db
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            slug: schema.projects.slug,
          })
          .from(schema.projects)
          .where(and(inArray(schema.projects.id, projectIds), ilike(schema.projects.name, like)))
          .limit(5)
      : [],
  ]);

  const results: SearchResult[] = [];

  for (const d of draftRows) {
    const label = d.title || (d.targetUser ? `@${d.targetUser}` : `Draft #${d.id}`);
    const sublabel = d.body ? d.body.slice(0, 120) : undefined;
    results.push({ kind: 'draft', id: d.id, label, sublabel, href: `/inbox?draft=${d.id}` });
  }
  for (const c of contactRows) {
    results.push({
      kind: 'contact',
      id: c.id,
      label: `@${c.targetUser}`,
      sublabel: c.accountHandle ? `via ${c.accountHandle}` : undefined,
      href: `/contacts?q=${encodeURIComponent(c.targetUser)}`,
    });
  }
  for (const c of campaignRows) {
    results.push({
      kind: 'campaign',
      id: c.id,
      label: c.name,
      href: `/campaigns/${c.id}`,
    });
  }
  for (const p of projectRows) {
    results.push({
      kind: 'project',
      id: p.id,
      label: p.name,
      sublabel: p.slug,
      href: `/settings`,
    });
  }

  return results;
}
