import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { POST as extensionPairConsume } from '../src/routes/api/extension/pair/+server.js';

/**
 * Issue #179: the public pairing-code redemption endpoint claims the code with
 * a single atomic conditional UPDATE (instead of a select-then-update), so two
 * concurrent redemptions of the same one-time code can never both mint a
 * device. (Per-IP rate limiting for this endpoint is tracked separately in
 * #194 - it needs the adapter-node forwarded-for config to key on the real
 * client IP behind Caddy.)
 */

type ConsumeEvent = Parameters<typeof extensionPairConsume>[0];

async function reset() {
  await getDb().execute(
    sql`TRUNCATE extension_devices, extension_pairings RESTART IDENTITY CASCADE`,
  );
}

async function insertPairing(code: string, expiresInMs = 10 * 60 * 1000) {
  const db = getDb();
  // A pairing must carry an org (a null-org pairing is now rejected at
  // redemption, #196), so seed it against the default org.
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  await db
    .insert(schema.extensionPairings)
    .values({ code, organizationId: org.id, expiresAt: new Date(Date.now() + expiresInMs) });
}

function consumeEvent(body: unknown): ConsumeEvent {
  return {
    request: new Request('http://x/api/extension/pair', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  } as unknown as ConsumeEvent;
}

async function statusOf(promise: Promise<Response>): Promise<number> {
  try {
    return (await promise).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

describe('extension pair redemption: atomic single-use', () => {
  beforeEach(reset);

  it('two concurrent redemptions of one code yield exactly one 200 and one device row', async () => {
    await insertPairing('AAAA-1111');

    const [statusA, statusB] = await Promise.all([
      statusOf(extensionPairConsume(consumeEvent({ code: 'AAAA-1111' }))),
      statusOf(extensionPairConsume(consumeEvent({ code: 'AAAA-1111' }))),
    ]);

    expect([statusA, statusB].sort()).toEqual([200, 404]);

    const devices = await getDb().select().from(schema.extensionDevices);
    expect(devices.length).toBe(1);

    const [row] = await getDb()
      .select({ consumedAt: schema.extensionPairings.consumedAt })
      .from(schema.extensionPairings)
      .where(eq(schema.extensionPairings.code, 'AAAA-1111'));
    expect(row.consumedAt).not.toBeNull();
  });

  it('a legitimate single redemption still succeeds and mints a device', async () => {
    await insertPairing('BBBB-2222');

    const res = await extensionPairConsume(consumeEvent({ code: 'BBBB-2222' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe('string');

    const devices = await getDb().select().from(schema.extensionDevices);
    expect(devices.length).toBe(1);
  });

  it('a second redemption of an already-consumed code is rejected', async () => {
    await insertPairing('CCCC-3333');
    const first = await extensionPairConsume(consumeEvent({ code: 'CCCC-3333' }));
    expect(first.status).toBe(200);

    const second = await statusOf(extensionPairConsume(consumeEvent({ code: 'CCCC-3333' })));
    expect(second).toBe(404);

    const devices = await getDb().select().from(schema.extensionDevices);
    expect(devices.length).toBe(1);
  });
});

afterAll(async () => {
  await getPool().end();
});
