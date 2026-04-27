import 'dotenv/config';
import { getDb, getPool, schema } from './client.js';
import { sql } from 'drizzle-orm';

export const QUOTA_DEFAULTS = {
  reddit: {
    dm: { perDay: 10, perWeek: 50 },
    comment: { perDay: 50, perWeek: 200 },
    post: { perDay: 5, perWeek: 20 },
  },
} as const;

export async function seedCore() {
  const db = getDb();
  await db.insert(schema.platforms).values({ slug: 'reddit', enabled: true }).onConflictDoNothing();
  await db
    .insert(schema.appConfig)
    .values({ key: 'quota_defaults', value: QUOTA_DEFAULTS })
    .onConflictDoNothing();
  const result = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from platforms`,
  );
  return { platforms: result.rows[0]?.count ?? 0 };
}

async function main() {
  const out = await seedCore();
  console.log(`platforms rows: ${out.platforms}`);
  await getPool().end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
