import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword } from '@pitchbox/shared/auth';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';
import { load } from '../src/routes/settings/admin/audit/+page.server.js';

// settings/admin/audit (#414). Same defense-in-depth gate as
// settings/admin/models/+page.server.ts: the area's layout already gates
// the subtree, this loader gates itself again - proven the same way
// settings-admin-gating.test.ts proves the layout gate.

const PASSWORD = 'correct-horse-battery';

async function userWith(username: string, isInstanceAdmin: boolean): Promise<{ id: number }> {
  const hash = await hashPassword(PASSWORD);
  await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash, isInstanceAdmin })
    .onConflictDoUpdate({ target: schema.users.username, set: { isInstanceAdmin } });
  const [user] = await getDb()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`username = ${username}`);
  return user;
}

type LoadEvent = Parameters<typeof load>[0];
type PageData = { rows: Array<{ key: string; actor: string; before: unknown; after: unknown }> };

describe('settings/admin/audit +page.server.ts load', () => {
  it('a signed-in user who is not the instance admin is forbidden (403)', async () => {
    const user = await userWith('iaap-plain', false);
    await expect(
      load({ locals: { user } } as unknown as LoadEvent),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('the instance admin sees recorded rows, readable in operator terms', async () => {
    const user = await userWith('iaap-iadmin', true);
    await recordInstanceAudit(getDb(), {
      key: 'default_runner',
      actor: { id: user.id, username: 'iaap-iadmin' },
      before: { slug: 'claude-code' },
      after: { slug: 'cloud' },
    });
    const data = (await load({ locals: { user } } as unknown as LoadEvent)) as PageData;
    const row = data.rows.find((r) => r.key === 'default_runner' && r.actor === 'iaap-iadmin');
    expect(row).toBeDefined();
    expect(row?.before).toEqual({ slug: 'claude-code' });
    expect(row?.after).toEqual({ slug: 'cloud' });
  });

  it('auth off has full access (200, no throw)', async () => {
    await expect(load({ locals: {} } as unknown as LoadEvent)).resolves.toBeDefined();
  });
});

afterAll(async () => {
  await getPool().end();
});
