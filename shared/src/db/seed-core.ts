import 'dotenv/config';
import { getDb, getPool, schema } from './client.js';
import { sql } from 'drizzle-orm';

async function main() {
  const db = getDb();
  await db
    .insert(schema.platforms)
    .values({ slug: 'reddit', enabled: true })
    .onConflictDoNothing();
  const result = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from platforms`,
  );
  const count = result.rows[0]?.count;
  console.log(`platforms rows: ${count}`);
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
