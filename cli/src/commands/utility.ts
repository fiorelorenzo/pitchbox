import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { and, eq } from 'drizzle-orm';
import { ok, fail } from '../lib/output.js';

async function platformIdBySlug(slug: string): Promise<number | null> {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p?.id ?? null;
}

export function registerUtilityCommands(program: Command) {
  program
    .command('staging:candidates')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(schema.stagingScoutCandidates)
        .where(eq(schema.stagingScoutCandidates.runId, Number(opts.run)));
      ok(rows.map((r) => r.raw));
    });

  program
    .command('blocklist:check')
    .requiredOption('--platform <slug>')
    .requiredOption('--user <handle>')
    .action(async (opts: { platform: string; user: string }) => {
      const pid = await platformIdBySlug(opts.platform);
      if (!pid) return fail(`platform ${opts.platform} not found`);
      const db = getDb();
      const [row] = await db
        .select()
        .from(schema.blocklist)
        .where(
          and(
            eq(schema.blocklist.platformId, pid),
            eq(schema.blocklist.kind, 'user'),
            eq(schema.blocklist.value, opts.user),
          ),
        );
      ok({ blocked: !!row, reason: row?.reason ?? null });
    });

  program
    .command('contact-history:check')
    .requiredOption('--platform <slug>')
    .requiredOption('--target <handle>')
    .action(async (opts: { platform: string; target: string }) => {
      const pid = await platformIdBySlug(opts.platform);
      if (!pid) return fail(`platform ${opts.platform} not found`);
      const db = getDb();
      const [row] = await db
        .select()
        .from(schema.contactHistory)
        .where(
          and(
            eq(schema.contactHistory.platformId, pid),
            eq(schema.contactHistory.targetUser, opts.target),
          ),
        );
      ok({ contacted: !!row, lastContactedAt: row?.lastContactedAt ?? null });
    });
}
