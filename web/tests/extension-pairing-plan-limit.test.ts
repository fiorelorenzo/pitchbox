import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { PLAN_CATALOGUE } from '@pitchbox/shared/plans';
import { POST as pairConsume } from '../src/routes/api/extension/pair/+server.js';

/**
 * #548: the pairing-code redemption endpoint (`POST /api/extension/pair`)
 * refuses once the org the code belongs to is at its plan's device limit -
 * the same enforcement point `auto-pair` has, but exercised here instead of
 * there because this route resolves its org from `extension_pairings.organizationId`
 * rather than from a session/`default`-org fallback, so it can be driven
 * against a dedicated, disposable org. `auto-pair`'s org resolution is only
 * reachable through the shared `default` org (self-host) or a session bound
 * to `AUTH_ON`, a module-load-time constant this suite cannot flip per test -
 * mutating `default`'s plan to force it into this test is exactly the
 * shared-table trap #373 already cost a run, so that path is intentionally
 * left covered only by inspection, not by a test.
 */

type ConsumeEvent = Parameters<typeof pairConsume>[0];

async function reset() {
  await getDb().execute(
    sql`TRUNCATE extension_devices, extension_pairings RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function makeOrg(slug: string, plan: string = 'free') {
  const [org] = await getDb()
    .insert(schema.organizations)
    .values({ slug, name: slug, plan })
    .returning();
  return org;
}

async function mintDevice(organizationId: number) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: randomUUID(), label: 'pre-existing device' });
}

async function insertPairing(organizationId: number, code: string) {
  await getDb()
    .insert(schema.extensionPairings)
    .values({ code, organizationId, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
}

function consumeEvent(code: string, ip: string): ConsumeEvent {
  return {
    request: new Request('http://x/api/extension/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
    getClientAddress: () => ip,
  } as unknown as ConsumeEvent;
}

describe('POST /api/extension/pair is plan-limit-gated (#548)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  const freeLimit = PLAN_CATALOGUE.free.extensionDevices!;

  it("refuses redemption once the code's org is at its plan device limit", async () => {
    expect(freeLimit).toBe(1);
    const org = await makeOrg('pairing-plan-limit-over');
    await mintDevice(org.id);
    await insertPairing(org.id, 'CODE-OVER-0001');

    const res = await pairConsume(consumeEvent('CODE-OVER-0001', '198.51.100.1'));

    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      error?: string;
      metric?: string;
      limit?: number;
      used?: number;
    };
    expect(body.error).toBe('plan_limit_reached');
    expect(body.metric).toBe('extensionDevices');
    expect(body.limit).toBe(freeLimit);

    // The refusal minted no second device ...
    const devices = await getDb()
      .select()
      .from(schema.extensionDevices)
      .where(eq(schema.extensionDevices.organizationId, org.id));
    expect(devices).toHaveLength(1);
    // ... but the code was still consumed by the atomic claim, per the
    // route's own documented trade-off (a refusal still burns a one-time
    // code rather than racing a separate read-only pre-check).
    const [pairing] = await getDb()
      .select()
      .from(schema.extensionPairings)
      .where(eq(schema.extensionPairings.code, 'CODE-OVER-0001'));
    expect(pairing.consumedAt).not.toBeNull();
  });

  it('an org under its device limit redeems the code and mints a device', async () => {
    const org = await makeOrg('pairing-plan-limit-under');
    await insertPairing(org.id, 'CODE-UNDER-0001');

    const res = await pairConsume(consumeEvent('CODE-UNDER-0001', '198.51.100.2'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string };
    expect(body.token).toBeTruthy();
    const devices = await getDb()
      .select()
      .from(schema.extensionDevices)
      .where(eq(schema.extensionDevices.organizationId, org.id));
    expect(devices).toHaveLength(1);
  });

  it('a self-host install refuses nothing, however many devices the org already has', async () => {
    delete process.env.PITCHBOX_EDITION;
    const org = await makeOrg('pairing-plan-limit-self-host');
    for (let i = 0; i < freeLimit + 5; i += 1) await mintDevice(org.id);
    await insertPairing(org.id, 'CODE-SELF-HOST-01');

    const res = await pairConsume(consumeEvent('CODE-SELF-HOST-01', '198.51.100.3'));

    expect(res.status).toBe(200);
  });
});
