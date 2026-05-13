import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '../src/db/client.js';
import {
  notify,
  listRecent,
  countUnread,
  markAllRead,
  saveWebhooks,
  loadWebhooks,
} from '../src/notifications.js';

async function reset() {
  await getDb().execute(sql`TRUNCATE notifications RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'notification_webhooks'`);
}

describe('shared/notifications', () => {
  beforeEach(reset);

  it('persists notify() rows with sensible defaults', async () => {
    await notify(getDb(), { kind: 'test.event', title: 'hello' });
    const rows = await listRecent(getDb());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('test.event');
    expect(rows[0].title).toBe('hello');
    expect(rows[0].severity).toBe('info');
    expect(rows[0].readAt).toBeNull();
  });

  it('countUnread reflects new rows and clears after markAllRead', async () => {
    await notify(getDb(), { kind: 'a', title: 'a' });
    await notify(getDb(), { kind: 'b', title: 'b' });
    expect(await countUnread(getDb())).toBe(2);
    await markAllRead(getDb());
    expect(await countUnread(getDb())).toBe(0);
  });

  it('saveWebhooks round-trips through app_config', async () => {
    expect(await loadWebhooks(getDb())).toEqual({});
    await saveWebhooks(getDb(), { url: 'https://hooks.example.com/foo' });
    expect(await loadWebhooks(getDb())).toEqual({ url: 'https://hooks.example.com/foo' });
    await saveWebhooks(getDb(), {});
    expect(await loadWebhooks(getDb())).toEqual({});
  });
});

afterAll(async () => {
  await getPool().end();
});
