import { describe, expect, it } from 'vitest';
import {
  findMissingMigrations,
  readJournalMigrations,
  readSupersededMigrations,
  type JournalMigration,
} from '../src/db/migration-audit.js';

const migrationsFolder = new URL('../src/db/migrations', import.meta.url).pathname;

// #493: drizzle skips a migration whose journal `when` is not greater than the
// newest already applied, and reports success anyway. The preview deployment
// lost `operator_voice_profiles` that way. These tests defend the audit that
// makes `migrate` fail loudly instead.

function entry(idx: number, tag: string, hash: string): JournalMigration {
  return { idx, when: 1788960000000 + idx, tag, hash };
}

describe('migration audit (#493)', () => {
  it('hashes the real journal the way the migrator records it', () => {
    const journal = readJournalMigrations(migrationsFolder);
    expect(journal.length).toBeGreaterThan(20);
    // The hash a real deployment recorded for 0020_instance_audit, read off
    // preview's own drizzle.__drizzle_migrations table. If the hashing ever
    // stops matching, every audit below is comparing nothing to nothing.
    const instanceAudit = journal.find((m) => m.tag === '0020_instance_audit');
    expect(instanceAudit?.hash).toBe(
      '037ed71ab0e4803ad63a649fdeee70050cfc761ed67fa35f058bf42c3f146891',
    );
  });

  it('reports a migration this database never applied', () => {
    const journal = [entry(1, 'a', 'hash-a'), entry(2, 'b', 'hash-b')];
    const missing = findMissingMigrations({
      journal,
      appliedHashes: new Set(['hash-a']),
      superseded: new Map(),
    });
    expect(missing.map((m) => m.tag)).toEqual(['b']);
  });

  it('says nothing when every journal migration is applied', () => {
    const journal = [entry(1, 'a', 'hash-a'), entry(2, 'b', 'hash-b')];
    expect(
      findMissingMigrations({
        journal,
        appliedHashes: new Set(['hash-a', 'hash-b']),
        superseded: new Map(),
      }),
    ).toEqual([]);
  });

  it('accepts a skipped migration on a database that ran its replacement', () => {
    // The repaired history: 0016 never ran here, 0021 re-issued it and did.
    const journal = [
      entry(16, 'skipped', 'hash-16'),
      entry(17, 'other', 'hash-17'),
      entry(21, 'repair', 'hash-21'),
    ];
    const missing = findMissingMigrations({
      journal,
      appliedHashes: new Set(['hash-17', 'hash-21']),
      superseded: new Map([['skipped', 'repair']]),
    });
    expect(missing).toEqual([]);
  });

  it('still reports the skipped migration when the replacement is missing too', () => {
    const journal = [entry(16, 'skipped', 'hash-16'), entry(21, 'repair', 'hash-21')];
    const missing = findMissingMigrations({
      journal,
      appliedHashes: new Set<string>(),
      superseded: new Map([['skipped', 'repair']]),
    });
    expect(missing.map((m) => m.tag)).toEqual(['skipped', 'repair']);
  });

  it('reads the superseded map and ignores its note keys', () => {
    const superseded = readSupersededMigrations(migrationsFolder);
    expect(superseded.get('0016_operator_voice_profile')).toBe(
      '0021_operator_voice_profiles_repair',
    );
    expect([...superseded.keys()].some((k) => k.startsWith('_'))).toBe(false);
  });

  it('names a real repair for every entry in the superseded map', () => {
    // A replacement that is not itself in the journal would silence a real
    // hole forever, which is the one way this mechanism could hurt.
    const journal = readJournalMigrations(migrationsFolder);
    const tags = new Set(journal.map((m) => m.tag));
    for (const [skipped, replacement] of readSupersededMigrations(migrationsFolder)) {
      expect(tags.has(skipped), `${skipped} must exist in the journal`).toBe(true);
      expect(tags.has(replacement), `${replacement} must exist in the journal`).toBe(true);
      const skippedWhen = journal.find((m) => m.tag === skipped)?.when ?? 0;
      const replacementWhen = journal.find((m) => m.tag === replacement)?.when ?? 0;
      expect(replacementWhen).toBeGreaterThan(skippedWhen);
    }
  });
});
