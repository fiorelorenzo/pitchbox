import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { getDb } from '../../../lib/server/db.js';
import { requireRole, requireInstanceAdmin } from '../../../lib/server/auth.js';
import { isCloud } from '@pitchbox/shared/edition';
import { t } from '$lib/i18n/index.js';
import {
  loadRetention,
  saveRetention,
  RETENTION_FLOOR_DAYS,
  type RetentionPolicy,
} from '@pitchbox/shared/retention';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';

// Retention describes the whole deployment, not any one organization
// (#183, same as default runner/quota defaults) - viewing it is gated to
// the per-org 'admin' role on self-host, but on cloud that role is not the
// right axis (any user can self-create an org and become its admin/owner),
// so viewing narrows to `requireInstanceAdmin` there too, the same gate the
// save action below already used. Both are no-ops when auth is off, so
// self-host is unaffected.
export const load: PageServerLoad = async (event) => {
  if (isCloud()) {
    await requireInstanceAdmin(event);
  } else {
    requireRole(event, 'admin'); // viewing retention is admin-only
  }
  const policy = await loadRetention(getDb());
  return { policy, floor: RETENTION_FLOOR_DAYS };
};

function parseDays(form: FormData, key: keyof RetentionPolicy): number | null {
  const raw = form.get(key);
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

export const actions: Actions = {
  default: async (event) => {
    // Retention is a single instance-wide app_config row (like default
    // runner, quota defaults, and webhook config), not per-org data, so
    // saving it needs requireInstanceAdmin, not just the per-org 'admin'
    // role - a self-created-org admin must not be able to change retention
    // for every tenant (#137).
    await requireInstanceAdmin(event);
    const form = await event.request.formData();
    const drafts_days = parseDays(form, 'drafts_days');
    const run_events_days = parseDays(form, 'run_events_days');
    const draft_events_days = parseDays(form, 'draft_events_days');
    const webhook_deliveries_days = parseDays(form, 'webhook_deliveries_days');
    if (
      drafts_days === null ||
      run_events_days === null ||
      draft_events_days === null ||
      webhook_deliveries_days === null
    ) {
      return fail(400, {
        error: t(event.locals.locale, 'settings.retention.error-invalid-number'),
      });
    }
    const db = getDb();
    const before = await loadRetention(db);
    // saveRetention enforces the floor server-side.
    const saved = await saveRetention(db, {
      drafts_days,
      run_events_days,
      draft_events_days,
      webhook_deliveries_days,
    });
    await recordInstanceAudit(db, {
      key: 'retention',
      actor: event.locals.user ?? null,
      before,
      after: saved,
    });
    return { saved };
  },
};
