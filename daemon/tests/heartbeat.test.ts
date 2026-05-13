import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { beat } from '../src/heartbeat.js';

describe('heartbeat.beat', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE daemon_heartbeats`);
  });

  it('inserts a row on first beat', async () => {
    const before = Date.now();
    await beat('test-module-a');

    const [row] = await getDb()
      .select()
      .from(schema.daemonHeartbeats)
      .where(eq(schema.daemonHeartbeats.module, 'test-module-a'));
    expect(row).toBeDefined();
    expect(row.tickAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('upserts tick_at on subsequent beats for the same module', async () => {
    await beat('test-module-b');
    const [first] = await getDb()
      .select()
      .from(schema.daemonHeartbeats)
      .where(eq(schema.daemonHeartbeats.module, 'test-module-b'));
    expect(first).toBeDefined();
    const firstTs = first.tickAt.getTime();

    // Small delay so a new timestamp would differ.
    await new Promise((r) => setTimeout(r, 50));
    await beat('test-module-b');

    const rows = await getDb()
      .select()
      .from(schema.daemonHeartbeats)
      .where(eq(schema.daemonHeartbeats.module, 'test-module-b'));
    expect(rows).toHaveLength(1);
    expect(rows[0].tickAt.getTime()).toBeGreaterThanOrEqual(firstTs);
  });

  it('keeps separate rows per module', async () => {
    await beat('test-module-x');
    await beat('test-module-y');

    const rows = await getDb()
      .select()
      .from(schema.daemonHeartbeats)
      .orderBy(schema.daemonHeartbeats.module);
    const modules = rows.map((r) => r.module);
    expect(modules).toContain('test-module-x');
    expect(modules).toContain('test-module-y');
  });

  it('lets callers clear heartbeats on graceful shutdown', async () => {
    // The daemon does not auto-delete on shutdown today, but the table is a
    // simple module-keyed upsert - verify that a manual clear works as the
    // shutdown story expects.
    await beat('shutdown-target');
    await getDb()
      .delete(schema.daemonHeartbeats)
      .where(eq(schema.daemonHeartbeats.module, 'shutdown-target'));
    const rows = await getDb()
      .select()
      .from(schema.daemonHeartbeats)
      .where(eq(schema.daemonHeartbeats.module, 'shutdown-target'));
    expect(rows).toHaveLength(0);
  });
});
