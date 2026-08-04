import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '../db/client.js';

/** Run statuses that mean a runner is (or is about to be) working on the campaign. */
const IN_FLIGHT_RUN_STATUSES = ['queued', 'running'] as const;

export class CampaignDeleteNameMismatchError extends Error {
  constructor() {
    super('Confirm name does not match campaign name');
  }
}

export class CampaignDeleteRunInFlightError extends Error {
  constructor(public runId: number) {
    super(`Campaign has a run in flight: ${runId}`);
  }
}

/**
 * Hard-delete a campaign, guarded by a typed confirmation of its name (the
 * campaign analogue of `deleteProject`'s confirm-slug; campaigns have no slug).
 *
 * The row's children go with it through the existing FKs: `runs.campaign_id`
 * cascades, and from a run so do its `drafts`, `run_events` and `draft_events`,
 * plus the campaign's `keyword_watches`. `contact_history.draft_id` is
 * `on delete set null`, so who we already contacted survives the delete and a
 * deleted campaign can never resurrect a target for re-contacting.
 *
 * Refuses while a run is queued or running: cascading rows out from under a
 * live runner would leave it writing into a run that no longer exists, and the
 * caller can cancel the run first.
 */
export async function deleteCampaign(db: Db, id: number, confirmName: string): Promise<void> {
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
  if (!campaign) return;
  if (campaign.name !== confirmName) throw new CampaignDeleteNameMismatchError();

  const [inFlight] = await db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(
      and(eq(schema.runs.campaignId, id), inArray(schema.runs.status, [...IN_FLIGHT_RUN_STATUSES])),
    )
    .limit(1);
  if (inFlight) throw new CampaignDeleteRunInFlightError(inFlight.id);

  await db.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
}
