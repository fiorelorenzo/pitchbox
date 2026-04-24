import { json, error } from '@sveltejs/kit';
import { runCampaign } from '$lib/server/runner.js';

export async function POST({ request }) {
	const { campaignId } = (await request.json()) as { campaignId?: number };
	if (!campaignId) throw error(400, 'campaignId required');
	const { runId } = await runCampaign(campaignId);
	return json({ runId });
}
