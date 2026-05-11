import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '../../src/db/client.js';
import {
  listLatestConfigs,
  getLatestConfig,
  saveConfigVersion,
  deleteConfigKey,
  ConfigConflictError,
} from '../../src/projects/configs.js';

async function makeProject(slug: string) {
  const db = getDb();
  const [p] = await db
    .insert(schema.projects)
    .values({ slug, name: slug })
    .returning({ id: schema.projects.id });
  return p.id;
}

describe('configs helpers', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE projects RESTART IDENTITY CASCADE`);
  });

  it('saveConfigVersion inserts version 1 then 2 then 3', async () => {
    const id = await makeProject('cfg-versioning');
    const a = await saveConfigVersion(getDb(), id, 'arbitrary.key', ['a'], null);
    expect(a.version).toBe(1);
    const b = await saveConfigVersion(getDb(), id, 'arbitrary.key', ['a', 'b'], 1);
    expect(b.version).toBe(2);
    const c = await saveConfigVersion(getDb(), id, 'arbitrary.key', ['a', 'b', 'c'], 2);
    expect(c.version).toBe(3);
  });

  it('listLatestConfigs returns latest version per key', async () => {
    const id = await makeProject('cfg-latest');
    await saveConfigVersion(getDb(), id, 'arbitrary.key', ['v1'], null);
    await saveConfigVersion(getDb(), id, 'arbitrary.key', ['v2'], 1);
    await saveConfigVersion(getDb(), id, 'other.key', { text: 'p1' }, null);
    const rows = await listLatestConfigs(getDb(), id);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['arbitrary.key'].value).toEqual(['v2']);
    expect(byKey['arbitrary.key'].version).toBe(2);
    expect(byKey['other.key'].version).toBe(1);
  });

  it('getLatestConfig returns null when missing', async () => {
    const id = await makeProject('cfg-missing');
    expect(await getLatestConfig(getDb(), id, 'arbitrary.key')).toBeNull();
  });

  it('saveConfigVersion throws ConfigConflictError on stale version', async () => {
    const id = await makeProject('cfg-conflict');
    await saveConfigVersion(getDb(), id, 'arbitrary.key', ['a'], null);
    await saveConfigVersion(getDb(), id, 'arbitrary.key', ['b'], 1);
    await expect(saveConfigVersion(getDb(), id, 'arbitrary.key', ['c'], 1)).rejects.toBeInstanceOf(
      ConfigConflictError,
    );
  });

  it('saveConfigVersion validates known key value', async () => {
    const id = await makeProject('cfg-validate');
    await expect(
      saveConfigVersion(getDb(), id, 'product.url', { url: 'not-a-url' }, null),
    ).rejects.toThrow();
  });

  it('deleteConfigKey removes all versions of that key', async () => {
    const id = await makeProject('cfg-delete');
    await saveConfigVersion(getDb(), id, 'arbitrary.key', ['a'], null);
    await saveConfigVersion(getDb(), id, 'arbitrary.key', ['b'], 1);
    await saveConfigVersion(getDb(), id, 'other.key', { text: 'p' }, null);
    await deleteConfigKey(getDb(), id, 'arbitrary.key');
    const remaining = await listLatestConfigs(getDb(), id);
    expect(remaining.map((r) => r.key)).toEqual(['other.key']);
  });
});
