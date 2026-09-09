import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

// Drizzle applies a migration only when its journal `when` is greater than the
// newest `when` already recorded in the database, and prints "migrations
// applied" either way. A migration authored on one branch and merged after a
// branch carrying a higher `when` is therefore skipped in silence. That is not
// hypothetical: `0016_operator_voice_profile` (when 1788960000003) merged after
// two migrations carrying 1788960000004 and 1788960000005, so the preview
// deployment never created `operator_voice_profiles`, `migrate` reported
// success, and the first request that read the table 500'd hours later (#493).
//
// Only a database with history can detect this, so the check runs at migrate
// time in every environment rather than as a test over the repo.

export interface JournalMigration {
  idx: number;
  when: number;
  tag: string;
  /** sha256 of the SQL file's raw bytes: how the migrator records it. */
  hash: string;
}

/** Reads the journal and hashes each migration the way drizzle does. */
export function readJournalMigrations(migrationsFolder: string): JournalMigration[] {
  const journal: unknown = JSON.parse(
    readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8'),
  );
  const entries =
    journal && typeof journal === 'object' && 'entries' in journal ? journal.entries : [];
  const out: JournalMigration[] = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (!raw || typeof raw !== 'object') continue;
    const tag = 'tag' in raw && typeof raw.tag === 'string' ? raw.tag : null;
    if (!tag) continue;
    const body = readFileSync(`${migrationsFolder}/${tag}.sql`, 'utf8');
    out.push({
      idx: 'idx' in raw && typeof raw.idx === 'number' ? raw.idx : -1,
      when: 'when' in raw && typeof raw.when === 'number' ? raw.when : -1,
      tag,
      hash: createHash('sha256').update(body).digest('hex'),
    });
  }
  return out;
}

/**
 * Skipped-migration tag to the tag of the migration that re-issues it. A
 * database that ran the replacement has a repaired history rather than a hole,
 * so the skipped one is acceptable there and only there.
 */
export function readSupersededMigrations(migrationsFolder: string): Map<string, string> {
  const raw: unknown = JSON.parse(
    readFileSync(`${migrationsFolder}/meta/_superseded.json`, 'utf8'),
  );
  const out = new Map<string, string>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [tag, replacement] of Object.entries(raw)) {
    // `_comment` and any future note key.
    if (tag.startsWith('_')) continue;
    if (typeof replacement === 'string') out.set(tag, replacement);
  }
  return out;
}

/**
 * Which journal migrations this database never applied, ignoring one that a
 * later migration already re-issued here. Sorted by journal order so the
 * report reads like the history it is describing.
 */
export function findMissingMigrations(args: {
  journal: JournalMigration[];
  appliedHashes: ReadonlySet<string>;
  superseded: ReadonlyMap<string, string>;
}): JournalMigration[] {
  const appliedTags = new Set(
    args.journal.filter((m) => args.appliedHashes.has(m.hash)).map((m) => m.tag),
  );
  return args.journal
    .filter((m) => !args.appliedHashes.has(m.hash))
    .filter((m) => {
      const replacement = args.superseded.get(m.tag);
      return !replacement || !appliedTags.has(replacement);
    })
    .sort((a, b) => a.idx - b.idx);
}

/** Migration indices the journal records, in no particular order. Reads only
 * `_journal.json`, not the `.sql` files themselves, so it works without a
 * real migrations directory on disk (see the test for this). */
function readJournalIndices(migrationsFolder: string): number[] {
  const journal: unknown = JSON.parse(
    readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8'),
  );
  const entries =
    journal && typeof journal === 'object' && 'entries' in journal ? journal.entries : [];
  const out: number[] = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (raw && typeof raw === 'object' && 'idx' in raw && typeof raw.idx === 'number') {
      out.push(raw.idx);
    }
  }
  return out;
}

const SNAPSHOT_FILE_RE = /^(\d{4})_snapshot\.json$/;

/** Migration indices that have a committed `meta/<idx>_snapshot.json`. */
function readSnapshotIndices(migrationsFolder: string): number[] {
  return readdirSync(`${migrationsFolder}/meta`)
    .map((name) => SNAPSHOT_FILE_RE.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
}

export interface SnapshotChainDrift {
  /** The highest migration index the journal actually records. */
  latestJournalIdx: number;
  /** The highest migration index with a committed snapshot, or null if none exist. */
  latestSnapshotIdx: number | null;
}

/**
 * `drizzle-kit generate` diffs `schema.ts` against whichever `meta/*_snapshot.json`
 * sorts last by filename - not against the journal, and not against every
 * migration in between. A snapshot that was never committed for the newest
 * migration makes `generate` diff against a stale state and re-emit DDL for
 * whatever landed after it, including tables that already exist (#527: the
 * chain stopped at `0018_snapshot.json` for six migrations - `0019`-`0024` -
 * each hand-authored because `generate` was already unusable, and `generate`
 * tried to re-`CREATE TABLE` `instance_audit_log` and `operator_voice_profiles`,
 * both already applied everywhere).
 *
 * Not every journal entry needs its own snapshot - a migration with no
 * drizzle-visible schema change (`0015`'s data backfill, `0021`'s idempotent
 * repair, `0022`'s hand-authored CHECK constraint) never gets one from a real
 * `generate` run either, the same way `0019` - never created at all - never
 * gets a journal entry. What has to hold is that the *last* migration in the
 * journal has a snapshot: that is the base the next `generate` will actually
 * diff against. `null` means the chain reaches the newest migration; a fresh
 * schema change should re-authenticate that immediately, not a month later
 * when someone tries to run `generate` and gets nonsense back.
 */
export function findSnapshotChainDrift(migrationsFolder: string): SnapshotChainDrift | null {
  const journalIndices = readJournalIndices(migrationsFolder);
  if (journalIndices.length === 0) return null;
  const latestJournalIdx = Math.max(...journalIndices);
  const snapshotIndices = readSnapshotIndices(migrationsFolder);
  const latestSnapshotIdx = snapshotIndices.length > 0 ? Math.max(...snapshotIndices) : null;
  if (latestSnapshotIdx === latestJournalIdx) return null;
  return { latestJournalIdx, latestSnapshotIdx };
}
