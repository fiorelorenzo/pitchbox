import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrationChain, MIGRATIONS_DIR } from '../src/db/migration-chain.js';

/**
 * The wave collision `AGENTS.md` documents reached `main` once (#543/#544):
 * two migrations generated against the same base snapshot, merged one after
 * the other, neither regenerated. Both `.sql` files applied cleanly in either
 * order, so no deploy and no test noticed; the next `migrate:generate` was
 * what found out, and it reported a snapshot collision rather than the pair
 * that caused it.
 *
 * These cases are built as throwaway metadata rather than as fixtures under
 * the real migrations directory, because a fixture that looks like a migration
 * is a fixture drizzle-kit will one day try to chain.
 */

const ZERO = '00000000-0000-0000-0000-000000000000';
const id = (n: number) => `1111111${n}-0000-0000-0000-00000000000${n}`;

type Entry = { idx: number; when: number; tag: string; breakpoints: boolean };

function write(
  entries: Entry[],
  snapshots: Record<string, { id: string; prevId: string }>,
  opts: { omitSql?: string[] } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'migchain-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(
    join(dir, 'meta/_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  for (const e of entries) {
    if (opts.omitSql?.includes(e.tag)) continue;
    writeFileSync(join(dir, `${e.tag}.sql`), '-- noop\n');
  }
  for (const [idx, snap] of Object.entries(snapshots)) {
    writeFileSync(join(dir, `meta/${idx}_snapshot.json`), JSON.stringify(snap));
  }
  return dir;
}

const entry = (idx: number, when: number, tag: string): Entry => ({
  idx,
  when,
  tag,
  breakpoints: true,
});

describe('checkMigrationChain', () => {
  it('accepts a sound chain', () => {
    const dir = write([entry(0, 100, '0000_first'), entry(1, 200, '0001_second')], {
      '0000': { id: id(1), prevId: ZERO },
      '0001': { id: id(2), prevId: id(1) },
    });
    expect(checkMigrationChain(dir)).toEqual([]);
  });

  it('reports the fork when two migrations share a parent snapshot', () => {
    const dir = write(
      [entry(0, 100, '0000_first'), entry(1, 200, '0001_a'), entry(2, 300, '0002_b')],
      {
        '0000': { id: id(1), prevId: ZERO },
        '0001': { id: id(2), prevId: id(1) },
        // Generated against 0000 as well, never regenerated on top of 0001.
        '0002': { id: id(3), prevId: id(1) },
      },
    );
    const problems = checkMigrationChain(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0002_b');
    expect(problems[0]).toContain('The chain forked');
  });

  it('accepts a hand-authored migration that has no snapshot at all', () => {
    // Four real migrations are like this, so a missing snapshot must not read
    // as a fork: the chain continues from the last snapshot that exists.
    const dir = write(
      [
        entry(0, 100, '0000_first'),
        entry(1, 200, '0001_hand_written'),
        entry(2, 300, '0002_generated'),
      ],
      { '0000': { id: id(1), prevId: ZERO }, '0002': { id: id(2), prevId: id(1) } },
    );
    expect(checkMigrationChain(dir)).toEqual([]);
  });

  it('reports a when value that would make drizzle skip the migration', () => {
    const dir = write([entry(0, 100, '0000_first'), entry(1, 100, '0001_same_when')], {
      '0000': { id: id(1), prevId: ZERO },
      '0001': { id: id(2), prevId: id(1) },
    });
    const problems = checkMigrationChain(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('will skip it');
  });

  it('reports a journal entry whose sql file is missing', () => {
    const dir = write(
      [entry(0, 100, '0000_first')],
      { '0000': { id: id(1), prevId: ZERO } },
      {
        omitSql: ['0000_first'],
      },
    );
    expect(checkMigrationChain(dir).join(' ')).toContain('no matching .sql file');
  });

  it('reports two entries claiming the same index', () => {
    const dir = write([entry(1, 100, '0001_mine'), entry(1, 200, '0001_yours')], {
      '0001': { id: id(1), prevId: ZERO },
    });
    expect(checkMigrationChain(dir).join(' ')).toContain('duplicate idx 1');
  });

  it('holds against the repo it guards', () => {
    // The real metadata, which is the only case that can regress on a merge.
    expect(checkMigrationChain(MIGRATIONS_DIR)).toEqual([]);
  });
});
