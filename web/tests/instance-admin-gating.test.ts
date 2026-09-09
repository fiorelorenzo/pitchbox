import { afterAll, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { notify, saveWebhooks } from '@pitchbox/shared/notifications';
import { POST as quotaPost } from '../src/routes/api/settings/quota/+server.js';
import { PUT as runnerConfigPut } from '../src/routes/api/settings/runner-config/+server.js';
import { PUT as defaultRunnerPut } from '../src/routes/api/settings/default-runner/+server.js';
import { POST as webhookRetryPost } from '../src/routes/api/webhooks/deliveries/[id]/retry/+server.js';
import { PUT as webhooksPut } from '../src/routes/api/settings/webhooks/+server.js';
import {
  GET as modelFunctionsGet,
  POST as modelFunctionsPost,
} from '../src/routes/api/settings/model-functions/+server.js';
import {
  GET as spendCeilingGet,
  PUT as spendCeilingPut,
} from '../src/routes/api/settings/admin/spend-ceiling/+server.js';
import { clearModelFunctionCache } from '@pitchbox/shared/ai/model-functions';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

const PASSWORD = 'correct-horse-battery';

// Captured at import time (before `runThroughHandle` sets PITCHBOX_AUTH='on')
// so afterAll can restore it and this file doesn't leak the env var into
// other test files sharing this worker.
const originalAuth = process.env.PITCHBOX_AUTH;

// These five routes gate instance-wide config (default runner, quota
// defaults, runner config, webhook retry, notification webhook config) that
// any self-created-org owner/admin could otherwise reach via POST /api/orgs +
// the per-org 'admin' role (#137). Driven through the REAL hooks.server
// `handle()` so the session cookie -> locals.user -> requireInstanceAdmin's
// own DB lookup all run for real, instead of hand-injecting
// `locals.user.isInstanceAdmin` to bypass the exact check under test.
async function sessionFor(
  username: string,
  role: 'member' | 'admin' | 'owner',
  isInstanceAdmin: boolean,
): Promise<CookieJar> {
  const hash = await hashPassword(PASSWORD);
  await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash, isInstanceAdmin })
    .onConflictDoUpdate({
      target: schema.users.username,
      set: { isInstanceAdmin },
    });
  const [user] = await getDb()
    .select()
    .from(schema.users)
    .where(sql`username = ${username}`);
  let [org] = await getDb()
    .select()
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  if (!org) {
    [org] = await getDb()
      .insert(schema.organizations)
      .values({ slug: 'default', name: 'Default' })
      .returning();
  }
  await getDb()
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user.id, role })
    .onConflictDoUpdate({
      target: [schema.memberships.organizationId, schema.memberships.userId],
      set: { role },
    });
  const session = await createSession(getDb(), user.id);
  return { store: new Map([['pitchbox_session', { value: session.id }]]) };
}

describe('instance-admin gating on global config routes', () => {
  describe('POST /api/settings/quota (via real handle)', () => {
    it('an org admin who is not instance-admin is forbidden (403)', async () => {
      const jar = await sessionFor('iag-quota-admin', 'admin', false);
      const req = new Request('http://localhost/api/settings/quota', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      await expect(runThroughHandle(req, jar, quotaPost as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an instance-admin succeeds (200)', async () => {
      const jar = await sessionFor('iag-quota-iadmin', 'admin', true);
      const req = new Request('http://localhost/api/settings/quota', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const res = await runThroughHandle(req, jar, quotaPost as any);
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /api/settings/runner-config (via real handle)', () => {
    it('an org admin who is not instance-admin is forbidden (403)', async () => {
      const jar = await sessionFor('iag-runner-admin', 'admin', false);
      const req = new Request('http://localhost/api/settings/runner-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'claude-code', config: {} }),
      });
      await expect(runThroughHandle(req, jar, runnerConfigPut as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an instance-admin succeeds (200)', async () => {
      const jar = await sessionFor('iag-runner-iadmin', 'admin', true);
      const req = new Request('http://localhost/api/settings/runner-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'claude-code', config: {} }),
      });
      const res = await runThroughHandle(req, jar, runnerConfigPut as any);
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /api/settings/webhooks (via real handle)', () => {
    it('an org admin who is not instance-admin is forbidden (403)', async () => {
      const jar = await sessionFor('iag-webhooks-admin', 'admin', false);
      const req = new Request('http://localhost/api/settings/webhooks', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test/hook' }),
      });
      await expect(runThroughHandle(req, jar, webhooksPut as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an instance-admin succeeds (200)', async () => {
      const jar = await sessionFor('iag-webhooks-iadmin', 'admin', true);
      const req = new Request('http://localhost/api/settings/webhooks', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test/hook' }),
      });
      const res = await runThroughHandle(req, jar, webhooksPut as any);
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /api/settings/default-runner (via real handle)', () => {
    it('an org admin who is not instance-admin is forbidden (403)', async () => {
      const jar = await sessionFor('iag-defrunner-admin', 'admin', false);
      const req = new Request('http://localhost/api/settings/default-runner', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'claude-code' }),
      });
      await expect(runThroughHandle(req, jar, defaultRunnerPut as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an instance-admin succeeds (200)', async () => {
      const jar = await sessionFor('iag-defrunner-iadmin', 'admin', true);
      const req = new Request('http://localhost/api/settings/default-runner', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'claude-code' }),
      });
      const res = await runThroughHandle(req, jar, defaultRunnerPut as any);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/webhooks/deliveries/[id]/retry (via real handle)', () => {
    async function seedDelivery(): Promise<number> {
      const [org] = await getDb()
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(sql`slug = 'default'`);
      await saveWebhooks(getDb(), { url: 'https://example.test/hook' });
      await notify(getDb(), { kind: 'iag.test.event', title: 'for gating test' }, org.id);
      const [delivery] = await getDb()
        .select({ id: schema.webhookDeliveries.id })
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.eventType, 'notification.iag.test.event'));
      return delivery.id;
    }

    it('an org admin who is not instance-admin is forbidden (403)', async () => {
      const deliveryId = await seedDelivery();
      const jar = await sessionFor('iag-webhook-admin', 'admin', false);
      const req = new Request(`http://localhost/api/webhooks/deliveries/${deliveryId}/retry`, {
        method: 'POST',
      });
      await expect(
        runThroughHandle(req, jar, (event: any) => {
          event.params = { id: String(deliveryId) };
          return webhookRetryPost(event);
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('an instance-admin succeeds (200)', async () => {
      const deliveryId = await seedDelivery();
      const jar = await sessionFor('iag-webhook-iadmin', 'admin', true);
      const req = new Request(`http://localhost/api/webhooks/deliveries/${deliveryId}/retry`, {
        method: 'POST',
      });
      const res = await runThroughHandle(req, jar, (event: any) => {
        event.params = { id: String(deliveryId) };
        return webhookRetryPost(event);
      });
      expect(res.status).toBe(200);
    });
  });

  describe('/api/settings/model-functions (via real handle)', () => {
    // Which model does which job is instance-wide (#411): an org admin who
    // created their own organization must not be able to swap the model every
    // other tenant's runs go through, or read what it is.
    it('an org admin who is not instance-admin is forbidden on the read (403)', async () => {
      const jar = await sessionFor('iag-models-admin', 'admin', false);
      const req = new Request('http://localhost/api/settings/model-functions');
      await expect(runThroughHandle(req, jar, modelFunctionsGet as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an org admin who is not instance-admin is forbidden on the write (403)', async () => {
      const jar = await sessionFor('iag-models-admin-w', 'admin', false);
      const req = new Request('http://localhost/api/settings/model-functions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fn: 'assist_suggest', modelId: 'openai/gpt-5-mini' }),
      });
      await expect(runThroughHandle(req, jar, modelFunctionsPost as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an instance-admin writes it and reads the new value back (200)', async () => {
      clearModelFunctionCache();
      const jar = await sessionFor('iag-models-iadmin', 'admin', true);
      const req = new Request('http://localhost/api/settings/model-functions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fn: 'assist_suggest', modelId: 'openai/gpt-5-mini' }),
      });
      const res = await runThroughHandle(req, jar, modelFunctionsPost as any);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ assist_suggest: 'openai/gpt-5-mini' });
    });

    it('rejects a function nobody defined instead of storing it', async () => {
      const jar = await sessionFor('iag-models-iadmin2', 'admin', true);
      const req = new Request('http://localhost/api/settings/model-functions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fn: 'not_a_function', modelId: 'openai/gpt-5-mini' }),
      });
      await expect(runThroughHandle(req, jar, modelFunctionsPost as any)).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('/api/settings/admin/spend-ceiling (via real handle)', () => {
    // #540: the instance-wide ceiling and the self-registration defaults
    // are exactly the config a self-created-org admin must never reach -
    // they are meant to bound that admin's own org, among every other one.
    const body = {
      instanceMonthlyBudgetUsd: 250,
      selfRegistrationMonthlyRunBudgetUsd: 5,
      selfRegistrationMaxConcurrentRuns: 1,
    };

    it('an org admin who is not instance-admin is forbidden on the read (403)', async () => {
      const jar = await sessionFor('iag-spend-admin-r', 'admin', false);
      const req = new Request('http://localhost/api/settings/admin/spend-ceiling');
      await expect(runThroughHandle(req, jar, spendCeilingGet as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an org admin who is not instance-admin is forbidden on the write (403)', async () => {
      const jar = await sessionFor('iag-spend-admin-w', 'admin', false);
      const req = new Request('http://localhost/api/settings/admin/spend-ceiling', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await expect(runThroughHandle(req, jar, spendCeilingPut as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an instance-admin writes it and reads the new values back (200)', async () => {
      const jar = await sessionFor('iag-spend-iadmin', 'admin', true);
      const putReq = new Request('http://localhost/api/settings/admin/spend-ceiling', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const putRes = await runThroughHandle(putReq, jar, spendCeilingPut as any);
      expect(putRes.status).toBe(200);

      const getReq = new Request('http://localhost/api/settings/admin/spend-ceiling');
      const getRes = await runThroughHandle(getReq, jar, spendCeilingGet as any);
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toMatchObject(body);
    });
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getPool().end();
});
