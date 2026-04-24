import { config } from 'dotenv';
import { resolve } from 'node:path';
// Load .env from repo root (two levels up from shared/src/db/)
config({ path: resolve(import.meta.dirname, '../../..', '.env') });
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });
  await pool.end();
  console.log('migrations applied');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
