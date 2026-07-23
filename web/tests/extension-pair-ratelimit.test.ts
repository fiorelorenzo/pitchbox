import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@pitchbox/shared/db';
import { POST as extensionPairConsume } from '../src/routes/api/extension/pair/+server.js';

/**
 * Issue #194: the public pairing-code redemption endpoint now throttles
 * attempts per source IP (web/src/lib/server/rate-limit.ts), so a correct
 * 8-hex-char code can't be brute-forced at unlimited speed. The
 * check-and-increment runs synchronously before the route's first `await`,
 * so building the whole burst with `Array.from` (which calls the route
 * function, and therefore the rate-limit check, once per element in a plain
 * synchronous loop before any of those calls' awaited work resolves) yields
 * a deterministic split between throttled and non-throttled attempts.
 */

type ConsumeEvent = Parameters<typeof extensionPairConsume>[0];

async function reset() {
  await getDb().execute(
    sql`TRUNCATE extension_devices, extension_pairings RESTART IDENTITY CASCADE`,
  );
}

function consumeEvent(body: unknown, ip: string): ConsumeEvent {
  return {
    request: new Request('http://x/api/extension/pair', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    getClientAddress: () => ip,
  } as unknown as ConsumeEvent;
}

async function statusOf(promise: Promise<Response>): Promise<number> {
  try {
    return (await promise).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

describe('extension pair redemption: per-IP rate limit', () => {
  beforeEach(reset);

  it('throttles a concurrent burst of invalid-code attempts from one IP after the threshold', async () => {
    const ip = '203.0.113.1';
    const statuses = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        statusOf(extensionPairConsume(consumeEvent({ code: `BAD-CODE-${i}` }, ip))),
      ),
    );

    // None of these codes exist, so every attempt that clears the rate
    // limiter resolves to 404 (invalid_or_expired_code); the rest are 429.
    const throttled = statuses.filter((s) => s === 429).length;
    const passedThrough = statuses.filter((s) => s === 404).length;
    expect(passedThrough).toBe(20);
    expect(throttled).toBe(5);
    expect(passedThrough + throttled).toBe(statuses.length);
  });

  it('does not throttle a different IP once one IP has hit its limit', async () => {
    const exhaustedIp = '203.0.113.5';
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        statusOf(extensionPairConsume(consumeEvent({ code: `USED-${i}` }, exhaustedIp))),
      ),
    );

    const blocked = await statusOf(
      extensionPairConsume(consumeEvent({ code: 'ONE-MORE' }, exhaustedIp)),
    );
    expect(blocked).toBe(429);

    const freshIp = '203.0.113.9';
    const unaffected = await statusOf(
      extensionPairConsume(consumeEvent({ code: 'FRESH-1' }, freshIp)),
    );
    expect(unaffected).toBe(404);
  });
});

afterAll(async () => {
  await getPool().end();
});
