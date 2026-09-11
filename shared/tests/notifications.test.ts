import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool } from '../src/db/client.js';
import { organizations } from '../src/db/schema.js';
import {
  notify,
  listRecent,
  countUnread,
  markAllRead,
  saveWebhooks,
  loadWebhooks,
  renderNotification,
} from '../src/notifications.js';
import { t, DEFAULT_LOCALE } from '../src/messages/index.js';

async function reset() {
  await getDb().execute(sql`TRUNCATE notifications RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'notification_webhooks'`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function defaultOrgId(): Promise<number> {
  const [row] = await getDb()
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, 'default'));
  return row.id;
}

async function otherOrgId(slug: string): Promise<number> {
  const [row] = await getDb()
    .insert(organizations)
    .values({ slug, name: slug })
    .returning({ id: organizations.id });
  return row.id;
}

describe('shared/notifications', () => {
  beforeEach(reset);

  it('persists notify() rows with sensible defaults', async () => {
    const orgId = await defaultOrgId();
    await notify(getDb(), { kind: 'test.event', title: 'hello' }, orgId);
    const rows = await listRecent(getDb(), orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('test.event');
    expect(rows[0].title).toBe('hello');
    expect(rows[0].severity).toBe('info');
    expect(rows[0].readAt).toBeNull();
    expect(rows[0].organizationId).toBe(orgId);
  });

  it('countUnread reflects new rows and clears after markAllRead', async () => {
    const orgId = await defaultOrgId();
    await notify(getDb(), { kind: 'a', title: 'a' }, orgId);
    await notify(getDb(), { kind: 'b', title: 'b' }, orgId);
    expect(await countUnread(getDb(), orgId)).toBe(2);
    await markAllRead(getDb(), orgId);
    expect(await countUnread(getDb(), orgId)).toBe(0);
  });

  it('saveWebhooks round-trips through app_config', async () => {
    expect(await loadWebhooks(getDb())).toEqual({});
    await saveWebhooks(getDb(), { url: 'https://hooks.example.com/foo' });
    expect(await loadWebhooks(getDb())).toEqual({ url: 'https://hooks.example.com/foo' });
    await saveWebhooks(getDb(), {});
    expect(await loadWebhooks(getDb())).toEqual({});
  });

  it('never leaks notifications, unread counts, or markAllRead across orgs', async () => {
    const orgA = await defaultOrgId();
    const orgB = await otherOrgId('notif-scope-b');

    await notify(getDb(), { kind: 'a.event', title: 'for org A' }, orgA);
    await notify(getDb(), { kind: 'b.event', title: 'for org B' }, orgB);
    await notify(getDb(), { kind: 'b.event2', title: 'also org B' }, orgB);

    const rowsA = await listRecent(getDb(), orgA);
    const rowsB = await listRecent(getDb(), orgB);
    expect(rowsA.map((r) => r.kind)).toEqual(['a.event']);
    expect(rowsB.map((r) => r.kind).sort()).toEqual(['b.event', 'b.event2']);

    expect(await countUnread(getDb(), orgA)).toBe(1);
    expect(await countUnread(getDb(), orgB)).toBe(2);

    // markAllRead scoped to org A must not touch org B's unread rows.
    await markAllRead(getDb(), orgA);
    expect(await countUnread(getDb(), orgA)).toBe(0);
    expect(await countUnread(getDb(), orgB)).toBe(2);
  });

  it('renderNotification re-renders a keyed row per reader locale, and returns a legacy row unchanged', async () => {
    const orgId = await defaultOrgId();
    // Any kind may adopt the LOR-288 payload convention, not just
    // checkUsageThresholds's - reusing an existing catalogue key here
    // keeps this test from depending on usage-notifications' own keys.
    await notify(
      getDb(),
      {
        kind: 'test.keyed',
        title: t(DEFAULT_LOCALE, 'api.runner_not_allowed', { runner: 'claude' }),
        payload: {
          i18nTitleKey: 'api.runner_not_allowed',
          i18nTitleParams: { runner: 'claude' },
        },
      },
      orgId,
    );
    const [row] = await listRecent(getDb(), orgId);

    // Two readers of this org, two different resolved locales - both
    // reading the one row that was ever written.
    expect(renderNotification(row, 'en').title).toBe(
      'Agent runner "claude" is not available in this deployment\'s edition.',
    );
    expect(renderNotification(row, 'it').title).toBe(
      'Il runner "claude" non è disponibile per questa installazione.',
    );

    // A legacy row - no i18n* payload key at all - renders its stored
    // title/body unchanged in every locale, never blanked and never a
    // raw key name.
    const legacyRow = { title: 'hello', body: null, payload: {} };
    expect(renderNotification(legacyRow, 'en')).toEqual({ title: 'hello', body: null });
    expect(renderNotification(legacyRow, 'it')).toEqual({ title: 'hello', body: null });
  });
});

afterAll(async () => {
  await getPool().end();
});
