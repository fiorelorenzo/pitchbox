import { afterAll, describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { loadInstanceAuditLog } from '@pitchbox/shared/instance-audit';
import { clearModelFunctionCache } from '@pitchbox/shared/ai/model-functions';
import { PUT as defaultRunnerPut } from '../src/routes/api/settings/default-runner/+server.js';
import { POST as quotaPost } from '../src/routes/api/settings/quota/+server.js';
import { PUT as runnerConfigPut } from '../src/routes/api/settings/runner-config/+server.js';
import { PUT as webhooksPut } from '../src/routes/api/settings/webhooks/+server.js';
import { POST as modelFunctionsPost } from '../src/routes/api/settings/model-functions/+server.js';
import { actions as retentionActions } from '../src/routes/settings/retention/+page.server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

// #414: every instance-wide write above is expected to call
// recordInstanceAudit once it succeeds. These tests drive each route as a
// real instance admin (same `sessionFor`/`runThroughHandle` pattern as
// instance-admin-gating.test.ts, which already covers the 403/200 gate) and
// assert on the resulting instance_audit_log row - the recording itself,
// not the gate.

const PASSWORD = 'correct-horse-battery';
const originalAuth = process.env.PITCHBOX_AUTH;

async function sessionFor(username: string): Promise<CookieJar> {
  const hash = await hashPassword(PASSWORD);
  await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash, isInstanceAdmin: true })
    .onConflictDoUpdate({
      target: schema.users.username,
      set: { isInstanceAdmin: true },
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
    .values({ organizationId: org.id, userId: user.id, role: 'admin' })
    .onConflictDoUpdate({
      target: [schema.memberships.organizationId, schema.memberships.userId],
      set: { role: 'admin' },
    });
  const session = await createSession(getDb(), user.id);
  return { store: new Map([['pitchbox_session', { value: session.id }]]) };
}

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE instance_audit_log RESTART IDENTITY`);
  await db.execute(
    sql`DELETE FROM app_config WHERE key IN ('default_runner', 'quota_defaults', 'runner_configs', 'notification_webhooks', 'retention', 'model_functions')`,
  );
  clearModelFunctionCache();
}

async function lastRowFor(key: string) {
  const rows = await loadInstanceAuditLog(getDb());
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no instance_audit_log row for key ${key}`);
  return row;
}

function retentionForm(vals: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(vals)) fd.set(k, v);
  return new Request('http://localhost/settings/retention', { method: 'POST', body: fd });
}

describe('instance-wide writes record an audit row', () => {
  beforeEach(reset);

  it('default-runner PUT records the slug change with the actor and before/after', async () => {
    const jar = await sessionFor('iat-defrunner');
    const put = (slug: string) =>
      runThroughHandle(
        new Request('http://localhost/api/settings/default-runner', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug }),
        }),
        jar,
        defaultRunnerPut as any,
      );
    expect((await put('claude-code')).status).toBe(200);
    expect((await put('codex')).status).toBe(200);

    const row = await lastRowFor('default_runner');
    expect(row.actor).toBe('iat-defrunner');
    expect(row.before).toEqual({ slug: 'claude-code' });
    expect(row.after).toEqual({ slug: 'codex' });
  });

  it('quota POST records the config change, not just the current value', async () => {
    const jar = await sessionFor('iat-quota');
    const post = (body: unknown) =>
      runThroughHandle(
        new Request('http://localhost/api/settings/quota', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        jar,
        quotaPost as any,
      );
    const first = { reddit: { dm: { perDay: 1, perWeek: 5 }, comment: { perDay: 1, perWeek: 5 }, post: { perDay: 1, perWeek: 5 } } };
    const second = { reddit: { dm: { perDay: 2, perWeek: 10 }, comment: { perDay: 2, perWeek: 10 }, post: { perDay: 2, perWeek: 10 } } };
    expect((await post(first)).status).toBe(200);
    expect((await post(second)).status).toBe(200);

    const row = await lastRowFor('quota_defaults');
    expect(row.before).toEqual(first);
    expect(row.after).toEqual(second);
  });

  it('runner-config PUT records under a per-runner key', async () => {
    const jar = await sessionFor('iat-runnercfg');
    const put = (config: unknown) =>
      runThroughHandle(
        new Request('http://localhost/api/settings/runner-config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug: 'claude-code', config }),
        }),
        jar,
        runnerConfigPut as any,
      );
    expect((await put({ model: 'sonnet' })).status).toBe(200);
    expect((await put({ model: 'opus' })).status).toBe(200);

    const row = await lastRowFor('runner_config:claude-code');
    expect(row.before).toEqual({ model: 'sonnet' });
    expect(row.after).toEqual({ model: 'opus' });
  });

  it('webhooks PUT records that the target changed without storing either URL', async () => {
    const jar = await sessionFor('iat-webhooks');
    const put = (url: string) =>
      runThroughHandle(
        new Request('http://localhost/api/settings/webhooks', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url }),
        }),
        jar,
        webhooksPut as any,
      );
    expect((await put('https://hooks.example.test/aaa')).status).toBe(200);
    expect((await put('https://hooks.example.test/bbb')).status).toBe(200);

    const row = await lastRowFor('notification_webhooks');
    const before = row.before as { url: { present: boolean; fingerprint: string } | null };
    const after = row.after as { url: { present: boolean; fingerprint: string } | null };
    expect(JSON.stringify(row)).not.toContain('hooks.example.test');
    expect(before.url?.present).toBe(true);
    expect(after.url?.present).toBe(true);
    expect(before.url?.fingerprint).not.toBe(after.url?.fingerprint);
  });

  it('model-functions POST records under a per-function key', async () => {
    const jar = await sessionFor('iat-modelfn');
    const post = (modelId: string) =>
      runThroughHandle(
        new Request('http://localhost/api/settings/model-functions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fn: 'assist_suggest', modelId }),
        }),
        jar,
        modelFunctionsPost as any,
      );
    expect((await post('openai/gpt-5-mini')).status).toBe(200);
    expect((await post('google/gemini-3.1-flash-lite')).status).toBe(200);

    const row = await lastRowFor('model_function:assist_suggest');
    expect(row.before).toEqual({ modelId: 'openai/gpt-5-mini' });
    expect(row.after).toEqual({ modelId: 'google/gemini-3.1-flash-lite' });
  });

  it('retention form action records the policy change', async () => {
    const jar = await sessionFor('iat-retention');
    const save = (drafts_days: string) =>
      runThroughHandle(
        retentionForm({
          drafts_days,
          run_events_days: '30',
          draft_events_days: '90',
          webhook_deliveries_days: '30',
        }),
        jar,
        retentionActions.default as any,
      );
    await save('90');
    await save('45');

    const row = await lastRowFor('retention');
    expect((row.before as { drafts_days: number }).drafts_days).toBe(90);
    expect((row.after as { drafts_days: number }).drafts_days).toBe(45);
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getPool().end();
});
