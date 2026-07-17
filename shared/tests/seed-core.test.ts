import { describe, expect, it, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, schema } from '../src/db/client.js';
import { seedCore, QUOTA_DEFAULTS } from '../src/db/seed-core.js';

// Covers MAS-7's seed-core contract: mastodon quota defaults are seeded
// conservatively (below reddit's), and the three mastodon scenario slugs are
// registered so a sibling playbook-writing agent's .md files get picked up.
describe('seedCore (mastodon quota defaults + scenarios)', () => {
  it('defines conservative mastodon quota defaults, below the reddit defaults', () => {
    expect(QUOTA_DEFAULTS.mastodon).toBeDefined();
    const m = QUOTA_DEFAULTS.mastodon;
    const r = QUOTA_DEFAULTS.reddit;
    expect(m.dm.perDay).toBeLessThan(r.dm.perDay);
    expect(m.dm.perWeek).toBeLessThan(r.dm.perWeek);
    expect(m.comment.perDay).toBeLessThan(r.comment.perDay);
    expect(m.comment.perWeek).toBeLessThan(r.comment.perWeek);
    expect(m.post.perDay).toBeLessThan(r.post.perDay);
    expect(m.post.perWeek).toBeLessThan(r.post.perWeek);
  });

  it('persists the mastodon key under app_config.quota_defaults on seed', async () => {
    const db = getDb();
    // seedCore inserts with onConflictDoNothing - other test files in this
    // shared-DB suite (e.g. draft-send.test.ts) upsert their own local
    // QUOTA_DEFAULTS mirror onto this same row between files, so clear it
    // first to make this assertion independent of suite run order.
    await db.delete(schema.appConfig).where(eq(schema.appConfig.key, 'quota_defaults'));
    await seedCore();
    const [row] = await db
      .select({ value: schema.appConfig.value })
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, 'quota_defaults'));
    expect(row).toBeTruthy();
    const value = row!.value as typeof QUOTA_DEFAULTS;
    expect(value.mastodon).toEqual(QUOTA_DEFAULTS.mastodon);
  });

  describe('mastodon scenario registration', () => {
    const MASTODON_SLUGS = ['mastodon-scout', 'mastodon-commenter', 'mastodon-poster'];
    let root: string;
    let originalRoot: string | undefined;

    afterEach(() => {
      process.env.PITCHBOX_ROOT = originalRoot;
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it('registers the three mastodon scenario slugs as built-in playbooks (contract for the sibling playbook agent)', async () => {
      // The sibling MAS-6 agent owns the actual playbooks/*.md bodies and
      // cannot touch seed-core; this repo's own playbooks/ dir may not have
      // those files yet. Point PITCHBOX_ROOT at a temp dir with fixture
      // bodies so this exercises the real readPlaybookBody + seedCore path
      // end to end, proving the slugs seed-core knows about are exactly the
      // three the sibling agent will reference.
      originalRoot = process.env.PITCHBOX_ROOT;
      root = mkdtempSync(join(tmpdir(), 'pitchbox-seed-core-'));
      mkdirSync(join(root, 'playbooks'), { recursive: true });
      for (const slug of MASTODON_SLUGS) {
        writeFileSync(join(root, 'playbooks', `${slug}.md`), `# ${slug}\n\nfixture body\n`);
      }
      process.env.PITCHBOX_ROOT = root;

      const db = getDb();
      const out = await seedCore();
      expect(out.playbooks).toBeGreaterThanOrEqual(MASTODON_SLUGS.length);

      const rows = await db
        .select({ slug: schema.playbooks.slug, isBuiltin: schema.playbooks.isBuiltin })
        .from(schema.playbooks)
        .where(eq(schema.playbooks.isBuiltin, true));
      const slugs = rows.map((r) => r.slug);
      for (const slug of MASTODON_SLUGS) {
        expect(slugs).toContain(slug);
      }
    });
  });
});
