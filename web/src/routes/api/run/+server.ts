import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { runCampaign } from '$lib/server/runner.js';
import { getCampaignReadiness } from '$lib/server/campaign-readiness.js';
import { getDb } from '$lib/server/db.js';
import { campaignBelongsToOrg } from '@pitchbox/shared/orgs';

const ALLOWED_TRIGGERS = new Set(['manual', 'scheduled', 'api', 'keyword']);

// Normalize an inbound trigger to a known value, defaulting unknown/missing to
// 'manual'. Exported so it can be unit-tested without the full dispatch path
// (which requires an installed agent CLI and is not portable to CI).
export function normalizeTrigger(raw: string | undefined): string {
  return raw && ALLOWED_TRIGGERS.has(raw) ? raw : 'manual';
}

export async function POST(event: RequestEvent) {
  const { request } = event;
  const body = (await request.json()) as {
    campaignId?: number;
    trigger?: string;
    scheduledFor?: string;
  };
  if (!body.campaignId) throw error(400, 'campaignId required');
  const trigger = normalizeTrigger(body.trigger);

  // Only session callers carry `locals.org`; the daemon/self-host dispatch
  // path has no request-scoped org (it calls this route without auth), so it
  // is intentionally left unguarded here - optional chaining keeps a fake
  // event with no `locals` from crashing rather than being rejected.
  if (event.locals?.org) {
    if (!(await campaignBelongsToOrg(getDb(), body.campaignId, event.locals.org.id))) {
      throw error(404, 'not_found');
    }
  }

  const readiness = await getCampaignReadiness(body.campaignId);
  if (!readiness.ready) {
    return json({ error: 'not_ready', issues: readiness.issues }, { status: 422 });
  }

  const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : null;
  try {
    const { runId, alreadyRunning } = await runCampaign(body.campaignId, trigger, scheduledFor);
    return json({ runId, alreadyRunning: alreadyRunning ?? false });
  } catch (err) {
    // The runner converts a UNIQUE violation on (campaign_id, scheduled_for)
    // into a tagged error so the route can return 409 cleanly.
    if ((err as { code?: string } | null)?.code === 'already_dispatched') {
      return json({ error: 'already_dispatched' }, { status: 409 });
    }
    throw err;
  }
}
