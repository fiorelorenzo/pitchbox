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
  // Mastodon (MAS-7): conservative on purpose - the fediverse is hostile to
  // cold marketing/DMs (see docs/mastodon-integration-design.md "Guardrails
  // / tone"), so every cap sits well below the Reddit defaults.
  mastodon: {
    dm: { perDay: 5, perWeek: 20 },
    comment: { perDay: 20, perWeek: 80 },
    post: { perDay: 3, perWeek: 10 },
  },
  // LinkedIn (LI-2): deliberately tighter than every other platform, because
  // the constraint here is reputational rather than technical - LinkedIn's
  // velocity monitoring treats a high-volume account as a bot regardless of
  // whether a human approved every draft (see
  // docs/linkedin-integration-design.md "Quota and blocklist"). dm is zero:
  // there is no linkedin-scout scenario and cold DM is out of scope for v1.
  linkedin: {
    dm: { perDay: 0, perWeek: 0 },
    comment: { perDay: 8, perWeek: 30 },
    post: { perDay: 1, perWeek: 4 },
  },
} as const;

// Single source of truth for the built-in playbook slugs, mirrored by
// SCENARIO_SLUGS in shared/src/campaigns/scenarios.ts. Exported so a test can
// assert the two agree with each other and with playbooks/*.md on disk (#351).
export const BUILTIN_PLAYBOOKS = [
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
  {
    slug: 'mastodon-scout',
    name: 'Mastodon scout',
    description:
      'Watch target hashtags and draft genuine, contextual DMs to good-fit posters, honoring #nobot.',
  },
  {
    slug: 'mastodon-commenter',
    name: 'Mastodon commenter',
    description: 'Draft helpful public replies to statuses that match the project.',
  },
  {
    slug: 'mastodon-poster',
    name: 'Mastodon poster',
    description: 'Draft proactive top-level statuses (toots) for the project.',
  },
  {
    slug: 'linkedin-commenter',
    name: 'LinkedIn commenter',
    description:
      'Draft helpful comments on LinkedIn posts the human has already observed in their own browser.',
  },
  {
    slug: 'linkedin-poster',
    name: 'LinkedIn poster',
    description: 'Draft proactive top-level LinkedIn posts for the connected profile.',
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
    .insert(schema.platforms)
    .values({ slug: 'mastodon', enabled: true })
    .onConflictDoNothing();
  await db
    .insert(schema.platforms)
    .values({ slug: 'linkedin', enabled: true })
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

  const missingSlugs: string[] = [];
  let playbookCount = 0;
  for (const pb of BUILTIN_PLAYBOOKS) {
    const body = readPlaybookBody(pb.slug);
    if (!body) {
      missingSlugs.push(pb.slug);
      continue;
    }
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

  // A registered slug with no markdown on disk is not a warning, it is a
  // scenario the campaign form offers that no playbook can serve (#351): this
  // is a setup-time script run by a human or CI, so failing loudly and naming
  // every missing slug is correct - the alternative is a healthy-looking
  // "playbooks seeded: N" count that hides exactly which N it dropped.
  if (missingSlugs.length > 0) {
    throw new Error(
      `seedCore: missing playbooks/<slug>.md for registered slug(s): ${missingSlugs.join(', ')}`,
    );
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
