// #551: the webhook route itself - reachable with no session even though
// the real hook forces PITCHBOX_AUTH=on (proves the web/src/hooks.server.ts
// exemption actually applies, the same regression class #132 documents for
// hand-injected locals.org), a bad signature refused before anything is
// written, and a valid one accepted end to end.
import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as webhookPost } from '../src/routes/api/stripe/webhook/+server.js';
import { runThroughHandle, type CookieJar } from './helpers/handle-harness.js';

const WEBHOOK_SECRET = 'whsec_test_route_secret';
const savedEnv: Record<string, string | undefined> = {};

function withEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function sign(body: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${signed}`;
}

function jar(): CookieJar {
  return { store: new Map() };
}

async function postWebhook(
  body: string,
  signatureHeader: string | null,
  origin?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signatureHeader) headers['stripe-signature'] = signatureHeader;
  if (origin) headers.origin = origin;
  const request = new Request('https://app.pitchbox.app/api/stripe/webhook', {
    method: 'POST',
    headers,
    body,
  });
  return runThroughHandle(request, jar(), (event) => webhookPost(event as never));
}

describe('POST /api/stripe/webhook', () => {
  it('404s when billing is disabled', async () => {
    withEnv({ PITCHBOX_BILLING: undefined });
    await expect(postWebhook('{}', null)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a bad signature with 400 and writes nothing, even with no session and a foreign Origin', async () => {
    withEnv({
      PITCHBOX_BILLING: 'on',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    const eventId = `evt_route_test_${randomUUID()}`;
    const body = JSON.stringify({
      id: eventId,
      type: 'customer.subscription.trial_will_end',
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    });
    const badSignature = sign(body, 'whsec_wrong_secret');
    await expect(postWebhook(body, badSignature, 'https://evil.example')).rejects.toMatchObject({
      status: 400,
    });

    const rows = await getDb()
      .select()
      .from(schema.stripeEvents)
      .where(eq(schema.stripeEvents.id, eventId));
    expect(rows).toHaveLength(0);
  });

  it('rejects a missing signature header the same way', async () => {
    withEnv({
      PITCHBOX_BILLING: 'on',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    await expect(postWebhook('{}', null)).rejects.toMatchObject({ status: 400 });
  });

  it('accepts a validly signed no-op event with no session, through the real hook', async () => {
    withEnv({
      PITCHBOX_BILLING: 'on',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    const eventId = `evt_route_test_${randomUUID()}`;
    const body = JSON.stringify({
      id: eventId,
      type: 'customer.subscription.trial_will_end',
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    });
    const res = await postWebhook(body, sign(body, WEBHOOK_SECRET), 'https://evil.example');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: 'no-op' });

    const [row] = await getDb()
      .select()
      .from(schema.stripeEvents)
      .where(eq(schema.stripeEvents.id, eventId));
    expect(row).toBeDefined();
    expect(row.processedAt).not.toBeNull();
  });
});
