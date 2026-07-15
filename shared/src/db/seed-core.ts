import 'dotenv/config';
import { getDb, getPool, schema } from './client.js';
import { sql, eq } from 'drizzle-orm';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUOTA_DEFAULTS = {
  reddit: {
    dm: { perDay: 10, perWeek: 50 },
    comment: { perDay: 50, perWeek: 200 },
    post: { perDay: 5, perWeek: 20 },
  },
} as const;

const BUILTIN_PLAYBOOKS = [
  {
    slug: 'reddit-scout',
    name: 'Reddit scout',
    description: 'Watch target subreddits and draft personalised DMs to good-fit posters.',
  },
  {
    slug: 'reddit-commenter',
    name: 'Reddit commenter',
    description: 'Draft helpful comment-replies that reference the product on target subreddits.',
  },
  {
    slug: 'reddit-poster',
    name: 'Reddit poster',
    description: 'Draft proactive top-level posts (title + body) for target subreddits.',
  },
  {
    slug: 'hn-commenter',
    name: 'Hacker News commenter',
    description: 'Draft helpful comment-replies on Hacker News stories that match the project.',
  },
  {
    slug: 'hn-poster',
    name: 'Hacker News poster',
    description: 'Draft proactive Show HN / Ask HN / text submissions (title + body).',
  },
];

function repoRoot(): string {
  const envRoot = process.env.PITCHBOX_ROOT;
  if (envRoot && isAbsolute(envRoot)) return envRoot;
  return resolve(fileURLToPath(new URL('../../../', import.meta.url)));
}

function readPlaybookBody(slug: string): string | null {
  const candidates = [
    resolve(repoRoot(), 'playbooks', `${slug}.md`),
    resolve(process.cwd(), 'playbooks', `${slug}.md`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

export async function seedCore() {
  const db = getDb();
  await db.insert(schema.platforms).values({ slug: 'reddit', enabled: true }).onConflictDoNothing();
  await db
    .insert(schema.platforms)
    .values({ slug: 'hackernews', enabled: true })
    .onConflictDoNothing();
  await db
    .insert(schema.organizations)
    // Placeholder name; the first user that signs up renames it after themselves
    // (see createUser). The slug 'default' is load-bearing (auth-off fallback).
    .values({ slug: 'default', name: 'My Organization' })
    .onConflictDoNothing();
  await db
    .insert(schema.appConfig)
    .values({ key: 'quota_defaults', value: QUOTA_DEFAULTS })
    .onConflictDoNothing();

  let playbookCount = 0;
  for (const pb of BUILTIN_PLAYBOOKS) {
    const body = readPlaybookBody(pb.slug);
    if (!body) continue;
    const [existing] = await db
      .select()
      .from(schema.playbooks)
      .where(eq(schema.playbooks.slug, pb.slug));
    if (existing) {
      // Keep user customisations: only refresh built-in rows that have not diverged.
      if (existing.isBuiltin) {
        await db
          .update(schema.playbooks)
          .set({ name: pb.name, description: pb.description, body, updatedAt: new Date() })
          .where(eq(schema.playbooks.slug, pb.slug));
      }
    } else {
      await db.insert(schema.playbooks).values({
        slug: pb.slug,
        name: pb.name,
        description: pb.description,
        body,
        isBuiltin: true,
      });
    }
    playbookCount += 1;
  }

  const result = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from platforms`,
  );
  return { platforms: result.rows[0]?.count ?? 0, playbooks: playbookCount };
}

async function main() {
  const out = await seedCore();
  console.log(`platforms rows: ${out.platforms}; playbooks seeded: ${out.playbooks}`);
  await getPool().end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
