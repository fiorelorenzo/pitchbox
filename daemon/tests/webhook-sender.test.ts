import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { tick } from '../src/webhook-sender.js';

const URL_OK = 'https://example.test/ok';
const URL_BAD = 'https://example.test/bad';

type FetchImpl = typeof fetch;

function mockFetch(impl: (url: string) => Response | Promise<Response>): FetchImpl {
  return (async (input: Parameters<FetchImpl>[0]) => {
    const u = typeof input === 'string' ? input : input.toString();
    return impl(u);
  }) as FetchImpl;
}

async function enqueue(url: string, opts: { attempts?: number; maxAttempts?: number } = {}) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, 'default'));
  const [row] = await db
    .insert(schema.webhookDeliveries)
    .values({
      organizationId: org.id,
      webhookId: 'test-hook',
      eventType: 'notification.test',
      payload: { url, body: { hello: 'world' } },
      attempts: opts.attempts ?? 0,
      maxAttempts: opts.maxAttempts ?? 3,
      status: 'pending',
    })
    .returning();
  return row;
}

async function getRow(id: number) {
  const [row] = await getDb()
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, id));
  return row;
}

describe('webhook-sender.tick', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE webhook_deliveries RESTART IDENTITY`);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('marks delivered on 2xx', async () => {
    globalThis.fetch = mockFetch(() => new Response('ok', { status: 200 }));
    const row = await enqueue(URL_OK);

    const res = await tick();
    expect(res.delivered).toBe(1);
    expect(res.picked).toBe(1);

    const after = await getRow(row.id);
    expect(after.status).toBe('delivered');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toBeNull();
  });

  it('schedules retry with backoff on 5xx', async () => {
    globalThis.fetch = mockFetch(() => new Response('boom', { status: 503 }));
    const row = await enqueue(URL_BAD, { maxAttempts: 5 });

    const before = Date.now();
    const res = await tick();
    expect(res.failed).toBe(1);
    expect(res.delivered).toBe(0);
    expect(res.dead).toBe(0);

    const after = await getRow(row.id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain('503');
    // First-failure backoff defaults to ~60s - must be strictly in the future.
    expect(after.nextAttemptAt.getTime()).toBeGreaterThan(before);
  });

  it('flips to dead once attempts hit the cap', async () => {
    globalThis.fetch = mockFetch(() => new Response('nope', { status: 500 }));
    // attempts already 2, max 3 → next failure pushes to 3 which is dead.
    const row = await enqueue(URL_BAD, { attempts: 2, maxAttempts: 3 });

    const res = await tick();
    expect(res.dead).toBe(1);
    expect(res.failed).toBe(0);

    const after = await getRow(row.id);
    expect(after.status).toBe('dead');
    expect(after.attempts).toBe(3);
  });

  it('manual retry path: resetting a dead row makes it pickable again', async () => {
    // 1) Drive a row to dead.
    globalThis.fetch = mockFetch(() => new Response('nope', { status: 500 }));
    const row = await enqueue(URL_BAD, { attempts: 2, maxAttempts: 3 });
    await tick();
    expect((await getRow(row.id)).status).toBe('dead');

    // 2) "Retry" - same shape as the /api/webhooks/deliveries/[id]/retry route.
    await getDb()
      .update(schema.webhookDeliveries)
      .set({
        status: 'pending',
        attempts: 0,
        lastError: null,
        // Backdate slightly so the worker's `next_attempt_at <= now()` filter
        // matches without a wallclock race.
        nextAttemptAt: new Date(Date.now() - 1000),
        updatedAt: new Date(),
      })
      .where(eq(schema.webhookDeliveries.id, row.id));

    // 3) This time the target responds 200.
    globalThis.fetch = mockFetch(() => new Response('ok', { status: 200 }));
    const res = await tick();
    expect(res.delivered).toBe(1);

    const after = await getRow(row.id);
    expect(after.status).toBe('delivered');
    expect(after.attempts).toBe(1);
  });
});
