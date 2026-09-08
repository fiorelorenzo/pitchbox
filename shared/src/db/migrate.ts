import { config } from 'dotenv';
import { resolve } from 'node:path';
// Load .env from repo root (two levels up from shared/src/db/)
config({ path: resolve(import.meta.dirname, '../../..', '.env') });
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import {
  findMissingMigrations,
  readJournalMigrations,
  readSupersededMigrations,
} from './migration-audit.js';

const migrationsFolder = new URL('./migrations', import.meta.url).pathname;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });

  // Verify rather than trust: drizzle says "migrations applied" even when its
  // own ordering rule made it skip one (#493, see migration-audit.ts).
  const journal = readJournalMigrations(migrationsFolder);
  const applied = await db.execute<{ hash: string }>(
    sql`select hash from drizzle.__drizzle_migrations`,
  );
  const missing = findMissingMigrations({
    journal,
    appliedHashes: new Set(applied.rows.map((r) => r.hash)),
    superseded: readSupersededMigrations(migrationsFolder),
  });
  await pool.end();

  if (missing.length > 0) {
    const newest = Math.max(...journal.map((m) => m.when));
    console.error(
      `ERROR: ${missing.length} migration(s) in the journal were never applied to this database:`,
    );
    for (const m of missing) console.error(`  - ${m.tag} (idx ${m.idx}, when ${m.when})`);
    console.error(
      'Drizzle skips a migration whose journal `when` is not greater than the newest one\n' +
        `already applied (newest in this journal: ${newest}). Re-issue the skipped migration as a\n` +
        'new file with a higher `when`, written so it is safe against a database that already has\n' +
        'the object (IF NOT EXISTS), and record it in migrations/meta/_superseded.json. Never edit\n' +
        'the skipped file in place: an applied migration and its recorded hash have to keep agreeing.',
    );
    process.exit(1);
  }

  console.log(`migrations applied (${journal.length} in journal, all present)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
