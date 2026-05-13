import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';

export type SearchResult = {
  kind: 'draft' | 'contact' | 'campaign' | 'project';
  id: number | string;
  label: string;
  sublabel?: string;
  href: string;
};

export async function search(q: string): Promise<SearchResult[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const db = getDb();
  const like = `%${trimmed}%`;

  const [draftRows, contactRows, campaignRows, projectRows] = await Promise.all([
    db
      .select({
        id: schema.drafts.id,
        targetUser: schema.drafts.targetUser,
        title: schema.drafts.title,
        body: schema.drafts.body,
      })
      .from(schema.drafts)
      .where(sql`${schema.drafts.body} ILIKE ${like} OR ${schema.drafts.targetUser} ILIKE ${like}`)
      .limit(5),
    db
      .select({
        id: schema.contactHistory.id,
        targetUser: schema.contactHistory.targetUser,
        accountHandle: schema.contactHistory.accountHandle,
      })
      .from(schema.contactHistory)
      .where(sql`${schema.contactHistory.targetUser} ILIKE ${like}`)
      .limit(5),
    db
      .select({ id: schema.campaigns.id, name: schema.campaigns.name })
      .from(schema.campaigns)
      .where(sql`${schema.campaigns.name} ILIKE ${like}`)
      .limit(5),
    db
      .select({ id: schema.projects.id, name: schema.projects.name, slug: schema.projects.slug })
      .from(schema.projects)
      .where(sql`${schema.projects.name} ILIKE ${like}`)
      .limit(5),
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

export async function GET({ url }: { url: URL }) {
  const q = url.searchParams.get('q') ?? '';
  const results = await search(q);
  return json({ results });
}
