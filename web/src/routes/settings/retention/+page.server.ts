import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { getDb } from '../../../lib/server/db.js';
import { requireRole } from '../../../lib/server/auth.js';
import {
  loadRetention,
  saveRetention,
  RETENTION_FLOOR_DAYS,
  type RetentionPolicy,
} from '@pitchbox/shared/retention';

export const load: PageServerLoad = async (event) => {
  requireRole(event, 'admin'); // viewing retention is admin-only
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
    requireRole(event, 'admin'); // editing retention is admin-only
    const form = await event.request.formData();
    const drafts_days = parseDays(form, 'drafts_days');
    const run_events_days = parseDays(form, 'run_events_days');
    const draft_events_days = parseDays(form, 'draft_events_days');
    if (drafts_days === null || run_events_days === null || draft_events_days === null) {
      return fail(400, { error: 'Invalid number' });
    }
    // saveRetention enforces the floor server-side.
    const saved = await saveRetention(getDb(), {
      drafts_days,
      run_events_days,
      draft_events_days,
    });
    return { saved };
  },
};
