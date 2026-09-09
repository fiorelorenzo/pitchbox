// Instance-wide config audit trail (#414). The org audit surface
// (web/src/lib/server/audit-feed.ts) unions draft_events and run_events,
// both reached through a project's organization_id - a write that belongs
// to no organization (the default runner, quota defaults, per-runner
// config, the notification webhook, retention, per-function model config,
// promoting an account to instance admin) has nowhere to land there and
// today leaves no trace anywhere. `recordInstanceAudit` is the one function
// every one of those writes calls, so "a route forgot to call it" is the
// only way this trail goes missing rather than "a route wrote it
// differently" - see instance_audit_log in db/schema.ts for the table.

import { desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { instanceAuditLog } from './db/schema.js';

// Loose on purpose (matches shared/src/orgs.ts's own alias): a real `Db`
// (shared/src/db/client.ts) and a `db.transaction` callback's `tx` are both
// assignable to this, and the Stripe webhook (#551) is the first caller
// that needs to write an audit row inside the same transaction as the
// state change it describes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

export type InstanceAuditActor = { id: number; username: string } | null;

export type InstanceAuditRow = {
  id: number;
  key: string;
  actor: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
};

/**
 * JSON field names that hold a credential outright (an API key, a signing
 * secret, a password) wherever they appear in a `before`/`after` payload,
 * regardless of which instance-wide write produced it. Matched against the
 * JSON key, not the app_config key, so a config shape added after this file
 * is written gets the same protection without anyone having to remember to
 * redact it by hand - the failure mode this guards against is a route that
 * calls `recordInstanceAudit` with its raw payload and never thinks about
 * redaction at all, which is the common case, not the exception.
 *
 * This is a name-based heuristic, not a guarantee: a field whose name
 * matches none of these patterns (a hypothetical `gatewayAccount` or
 * `smtpUser`, say) is stored as-is even if its value is sensitive. A new
 * instance-wide write has to be read once with that in mind - either its
 * shape genuinely holds nothing sensitive, or its field gets a name this
 * pattern (or the `*url` one below) actually catches, or it needs its own
 * explicit redaction before it ever reaches `recordInstanceAudit`.
 */
const SECRET_FIELD_PATTERN = /(key|token|secret|password|credential)/i;

/**
 * A field named `*url` can itself carry a credential - a Slack/Discord/
 * generic webhook target commonly embeds a bearer token or signing secret
 * in its path or query string, and the notification webhook config
 * (shared/src/notifications.ts) is exactly that shape. The raw value never
 * reaches the row: only whether one is set, and a stable fingerprint (same
 * sha256-prefix construction as `webhookIdForUrl`) so two audit rows can be
 * told apart - "the webhook changed" is visible without exposing what
 * either URL was.
 */
const URL_FIELD_PATTERN = /url$/i;

function fingerprintUrl(url: string): string {
  // Inlined rather than imported from notifications.ts's webhookIdForUrl:
  // that function is about identifying a delivery target, this one is about
  // never storing the target itself, and the two call sites should be free
  // to diverge without this file reaching into notifications.ts for it.
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function redactField(key: string, value: unknown): unknown {
  if (value == null) return value;
  if (SECRET_FIELD_PATTERN.test(key)) return '[redacted]';
  if (URL_FIELD_PATTERN.test(key) && typeof value === 'string' && value) {
    return { present: true, fingerprint: fingerprintUrl(value) };
  }
  return redactInstanceAuditValue(value);
}

/**
 * Recursively applies the redaction rules above to an arbitrary JSON value.
 * Exported so the redaction itself is directly testable rather than only
 * observable through a full `recordInstanceAudit` round trip.
 */
export function redactInstanceAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactInstanceAuditValue(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactField(k, v);
    }
    return out;
  }
  return value;
}

/**
 * Records one instance-wide configuration write: who (the signed-in user,
 * or 'self-host' when auth is off - same no-op convention as
 * `requireInstanceAdmin`), when (defaulted by the table), which key, and
 * the value on each side of the write. `before`/`after` are redacted here,
 * not by the caller, so a route that hands this its raw payload still gets
 * the credential guard above for free.
 *
 * Every route gated by `requireInstanceAdmin` that writes instance-wide
 * config is expected to call this once, after the write succeeds:
 * default-runner PUT, runner-config PUT, quota POST, webhooks PUT,
 * retention's form action, model-functions POST, and the account-promotion
 * action (web/src/routes/api/settings/admin/promote/+server.ts, #413).
 */
export async function recordInstanceAudit(
  db: Db,
  input: { key: string; actor: InstanceAuditActor; before: unknown; after: unknown },
): Promise<void> {
  await db.insert(instanceAuditLog).values({
    key: input.key,
    actor: input.actor?.username ?? 'self-host',
    before: redactInstanceAuditValue(input.before) ?? null,
    after: redactInstanceAuditValue(input.after) ?? null,
  });
}

/** Time-ordered instance audit rows, most recent first, for the admin area. */
export async function loadInstanceAuditLog(db: Db, limit = 200): Promise<InstanceAuditRow[]> {
  const rows = await db
    .select()
    .from(instanceAuditLog)
    .orderBy(desc(instanceAuditLog.createdAt), desc(instanceAuditLog.id))
    .limit(limit);
  return rows;
}
