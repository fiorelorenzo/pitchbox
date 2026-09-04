import { count, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema.js';

/**
 * The MCP tool each playbook kind must reach to commit its result (#221).
 *
 * Every tool in this table writes the run's terminal status in the SAME
 * transaction as the artifact it produces - the project description, the
 * campaign profile, the draft body, the insights summary. So a run still
 * sitting in `running` when the agent process exits cleanly is proof that the
 * tool never ran and nothing was saved, whatever the agent said in its last
 * message.
 *
 * `campaign` is the one kind whose artifact is written elsewhere: the scouts
 * and commenters insert `drafts` rows one at a time via `drafts_create`, and
 * `run_finish` only closes the run. A campaign run that drafted something did
 * its job even if it forgot the bookkeeping call, so that case is checked
 * against the drafts, not against the run status.
 *
 * `assist` (#313) is deliberately absent, not merely unmentioned: an assist
 * run has no playbook, no MCP session and no agent that could call a finish
 * tool at all - it is created by `shared/src/assist-accept.ts` already
 * terminal (`status: 'success'`), in the same transaction as the draft it
 * produced. This map is only consulted for a run still `running` after its
 * agent process exits, which never happens for `assist` (there is no
 * process), so `playbookContractError` below returns null for it via the
 * `if (!tool) return null` fallthrough rather than a special case.
 */
export const PLAYBOOK_FINISH_TOOL: Record<string, string> = {
  campaign: 'run_finish',
  campaign_skill_generation: 'skill_generate_finish',
  draft_regeneration: 'draft_regen_finish',
  project_extraction: 'project_extract_finish',
  project_insights: 'project_insights',
  reply_drafting: 'reply_draft_finish',
};

/**
 * Decide whether a run whose agent exited 0 actually honoured its playbook
 * contract. Call it only for a run that is still non-terminal: a run the finish
 * tool already closed never gets here.
 *
 * Returns the error to record on the run, or null when the run may be counted
 * as a success.
 */
export async function playbookContractError(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  run: { id: number; kind: string },
): Promise<string | null> {
  const tool = PLAYBOOK_FINISH_TOOL[run.kind];
  if (!tool) return null;

  if (run.kind === 'campaign') {
    const [row] = await db
      .select({ drafts: count() })
      .from(schema.drafts)
      .where(eq(schema.drafts.runId, run.id));
    if ((row?.drafts ?? 0) > 0) return null;
    return `the agent ended its turn without creating any draft and never called ${tool}`;
  }

  return `the agent ended its turn without calling ${tool}, so the run saved nothing`;
}
