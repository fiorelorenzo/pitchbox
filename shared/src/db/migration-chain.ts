import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards drizzle-kit's own migration metadata against the wave collision
 * `AGENTS.md` already documents, which reached `main` once (#543/#544).
 *
 * `0025_supreme_molecule_man` and `0026_email_verification_tokens` were both
 * generated against the same base snapshot and merged one after the other with
 * neither regenerated on top of the other, so `0026_snapshot.json`'s `prevId`
 * pointed at `0025`'s parent instead of at `0025`'s own `id`: a fork, not a
 * chain. Both `.sql` files applied cleanly in either order, so no deploy and
 * no test noticed. The next person to run `pnpm run migrate:generate` was the
 * one who found out, and the error named a snapshot collision rather than the
 * pair that caused it.
 *
 * This is metadata only and touches no database, which is what lets it run in
 * the PR-time `quality` job. `migration-audit.ts` next door is the complement:
 * it needs a database with history, so it runs at migrate time instead.
 */

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** One line per problem. Empty means the metadata is sound. */
export function checkMigrationChain(dir: string = MIGRATIONS_DIR): string[] {
  const journalPath = join(dir, 'meta/_journal.json');
  if (!existsSync(journalPath)) return [`no journal at ${journalPath}`];
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: JournalEntry[] };
  const entries = journal.entries ?? [];
  if (entries.length === 0) return ['journal has no entries'];

  const problems: string[] = [];
  const seen = new Map<number, string>();
  let prevId = ZERO_UUID;
  let prevSnapshotTag = '(none)';

  for (const [i, entry] of entries.entries()) {
    const claimed = seen.get(entry.idx);
    if (claimed) {
      problems.push(
        `duplicate idx ${entry.idx}: ${claimed} and ${entry.tag} both claim it, which is two migrations generated in the same wave`,
      );
    }
    seen.set(entry.idx, entry.tag);

    if (!existsSync(join(dir, `${entry.tag}.sql`))) {
      problems.push(`${entry.tag}: in the journal with no matching .sql file`);
    }

    // Drizzle applies a migration only when its `when` exceeds the newest one
    // already applied, so a non-increasing pair is a migration that skips in
    // silence. `0013` carries a deliberate future timestamp (#493), which is
    // why this checks the sequence rather than comparing against the clock.
    if (i > 0 && entry.when <= entries[i - 1].when) {
      problems.push(
        `${entry.tag}: when=${entry.when} is not greater than ${entries[i - 1].tag}'s ${entries[i - 1].when}, so drizzle will skip it`,
      );
    }

    // A hand-authored migration has no snapshot at all, and four real ones do
    // not, so a missing snapshot must never read as a fork: the chain simply
    // continues from the last snapshot that exists.
    const snapshotPath = join(dir, `meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`);
    if (!existsSync(snapshotPath)) continue;
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      id: string;
      prevId: string;
    };
    if (snapshot.prevId !== prevId) {
      problems.push(
        `${entry.tag}: snapshot prevId is ${snapshot.prevId}, expected ${prevId} (${prevSnapshotTag}'s id). The chain forked, so regenerate this migration on top of the other one rather than editing the snapshot`,
      );
    }
    prevId = snapshot.id;
    prevSnapshotTag = entry.tag;
  }

  return problems;
}
