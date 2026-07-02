import { config } from 'dotenv';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq } from 'drizzle-orm';

config({ path: resolve(import.meta.dirname ?? '.', '..', '.env') });

// Source path is environment-specific, so take it from an env var or the first
// CLI arg rather than hardcoding it. Example:
//   AI_GAME_CONTACTED_JSON=/path/to/contacted.json pnpm tsx scripts/migrate-from-ai-game.ts
//   pnpm tsx scripts/migrate-from-ai-game.ts /path/to/contacted.json
const CONTACTED_PATH = process.env.AI_GAME_CONTACTED_JSON ?? process.argv[2] ?? '';

async function main() {
  if (!CONTACTED_PATH || !existsSync(CONTACTED_PATH)) {
    console.log(
      'No contacted.json found (set AI_GAME_CONTACTED_JSON or pass a path arg); nothing to import.',
    );
    await getPool().end();
    return;
  }
  const raw = JSON.parse(readFileSync(CONTACTED_PATH, 'utf8')) as Array<
    string | { handle: string; at?: string }
  >;
  const entries = raw.map((e) => (typeof e === 'string' ? { handle: e, at: undefined } : e));
  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  if (!platform) throw new Error('platform reddit missing; run seed:core');

  let inserted = 0;
  for (const e of entries) {
    await db.insert(schema.contactHistory).values({
      platformId: platform.id,
      accountHandle: 'unknown',
      targetUser: e.handle,
      lastContactedAt: e.at ? new Date(e.at) : new Date(),
    });
    inserted++;
  }
  console.log(`imported ${inserted} contact history rows`);
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
