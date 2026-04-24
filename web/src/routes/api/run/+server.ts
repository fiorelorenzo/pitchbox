import { json, error } from '@sveltejs/kit';
import { runCampaign } from '$lib/server/runner.js';

const ALLOWED_TRIGGERS = new Set(['manual', 'scheduled', 'api']);

export async function POST({ request }) {
  const body = (await request.json()) as { campaignId?: number; trigger?: string };
  if (!body.campaignId) throw error(400, 'campaignId required');
  const trigger = body.trigger && ALLOWED_TRIGGERS.has(body.trigger) ? body.trigger : 'manual';
  const { runId, alreadyRunning } = await runCampaign(body.campaignId, trigger);
  return json({ runId, alreadyRunning: alreadyRunning ?? false });
}
