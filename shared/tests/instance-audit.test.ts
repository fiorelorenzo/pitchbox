import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import {
  recordInstanceAudit,
  loadInstanceAuditLog,
  redactInstanceAuditValue,
} from '../src/instance-audit.js';

// #414: instance-wide config writes (default runner, quota defaults, runner
// config, notification webhook, retention, per-function model config,
// account promotion) have nowhere to land in the org-scoped audit feed. The
// properties worth defending are the ones the issue names directly: who,
// when, which key, before/after, and that a credential-shaped value never
// reaches the row.

async function reset() {
  await getDb().execute(sql`TRUNCATE instance_audit_log RESTART IDENTITY`);
}

describe('recordInstanceAudit', () => {
  beforeEach(reset);

  it('records who, which key, and the value on each side of the write', async () => {
    const db = getDb();
    await recordInstanceAudit(db, {
      key: 'default_runner',
      actor: { id: 7, username: 'lorenzo' },
      before: { slug: 'claude-code' },
      after: { slug: 'cloud' },
    });
    const [row] = await loadInstanceAuditLog(db);
    expect(row.key).toBe('default_runner');
    expect(row.actor).toBe('lorenzo');
    expect(row.before).toEqual({ slug: 'claude-code' });
    expect(row.after).toEqual({ slug: 'cloud' });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("records 'self-host' as the actor when auth is off (no signed-in user)", async () => {
    const db = getDb();
    await recordInstanceAudit(db, {
      key: 'quota_defaults',
      actor: null,
      before: {},
      after: { reddit: { dm: { perDay: 5, perWeek: 20 } } },
    });
    const [row] = await loadInstanceAuditLog(db);
    expect(row.actor).toBe('self-host');
  });

  it('orders rows most recent first', async () => {
    const db = getDb();
    await recordInstanceAudit(db, {
      key: 'retention',
      actor: null,
      before: { drafts_days: 90 },
      after: { drafts_days: 30 },
    });
    await recordInstanceAudit(db, {
      key: 'retention',
      actor: null,
      before: { drafts_days: 30 },
      after: { drafts_days: 14 },
    });
    const rows = await loadInstanceAuditLog(db);
    expect(rows.map((r) => (r.after as { drafts_days: number }).drafts_days)).toEqual([14, 30]);
  });

  it('never stores a raw notification webhook URL, only a fingerprint', async () => {
    const db = getDb();
    const secretUrl = 'https://hooks.slack.com/services/T00/B00/super-secret-token';
    await recordInstanceAudit(db, {
      key: 'notification_webhooks',
      actor: null,
      before: { url: null },
      after: { url: secretUrl },
    });
    const [row] = await loadInstanceAuditLog(db);
    const after = row.after as { url: unknown };
    // Bites: an implementation that stores `before`/`after` verbatim (the
    // obvious thing to write) would put the token-bearing URL straight into
    // `after.url`, and this assertion fails against it - it only passes
    // once the value has actually been transformed.
    expect(JSON.stringify(after)).not.toContain('super-secret-token');
    expect(JSON.stringify(after)).not.toContain(secretUrl);
    expect(after.url).toEqual({ present: true, fingerprint: expect.any(String) });
  });

  it('redacts a field that literally holds a credential', async () => {
    const db = getDb();
    await recordInstanceAudit(db, {
      key: 'runner_config:cloud',
      actor: null,
      before: {},
      after: { model: 'sonnet', gatewayApiKey: 'sk-live-do-not-store-me' },
    });
    const [row] = await loadInstanceAuditLog(db);
    const after = row.after as { model: string; gatewayApiKey: string };
    expect(JSON.stringify(after)).not.toContain('sk-live-do-not-store-me');
    expect(after.gatewayApiKey).toBe('[redacted]');
    // A field with no credential in its name is untouched.
    expect(after.model).toBe('sonnet');
  });
});

describe('redactInstanceAuditValue', () => {
  it('leaves a plain value with no sensitive fields unchanged', () => {
    expect(redactInstanceAuditValue({ drafts_days: 90, run_events_days: 30 })).toEqual({
      drafts_days: 90,
      run_events_days: 30,
    });
  });

  it('two different URLs fingerprint differently, so a change is still visible', () => {
    const a = redactInstanceAuditValue({ url: 'https://a.example.com/hook' }) as {
      url: { fingerprint: string };
    };
    const b = redactInstanceAuditValue({ url: 'https://b.example.com/hook' }) as {
      url: { fingerprint: string };
    };
    expect(a.url.fingerprint).not.toBe(b.url.fingerprint);
  });

  it('redacts a secret field nested inside an array', () => {
    const out = redactInstanceAuditValue([{ token: 'abc123' }, { model: 'sonnet' }]) as Array<
      Record<string, unknown>
    >;
    expect(out[0].token).toBe('[redacted]');
    expect(out[1].model).toBe('sonnet');
  });
});
