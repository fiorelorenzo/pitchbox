import { and, eq } from 'drizzle-orm';
import { getDb, schema } from './db.js';
import { getSchema } from '@pitchbox/shared/campaigns';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { detectRunner } from '@pitchbox/shared/agents/detect';

export type ReadinessIssue = {
  id:
    | 'profile_missing'
    | 'profile_invalid'
    | 'profile_generating'
    | 'no_account'
    | 'runner_unavailable';
  title: string;
  hint: string;
  // `kind: 'progress'` signals an in-progress async operation: the UI should
  // render a spinner and no action button.
  fix: {
    label: string;
    kind: 'profile' | 'accounts' | 'runner' | 'progress';
    href?: string;
  };
};

export type CampaignReadiness = {
  ready: boolean;
  issues: ReadinessIssue[];
  // Live operational state. The campaign page reads these so it can disable
  // "Run now" / "Generate profile" buttons while an underlying run is still
  // executing, even when the run itself doesn't block readiness.
  generatingProfile: boolean;
  campaignRunning: boolean;
};

export async function getCampaignReadiness(campaignId: number): Promise<CampaignReadiness> {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  if (!campaign) {
    return { ready: false, issues: [], generatingProfile: false, campaignRunning: false };
  }

  // Detect in-progress operations against this campaign so the banner can
  // surface "Generating…" instead of nagging the user to start something
  // that's already going, and so the page can disable redundant triggers.
  const runningRuns = await db
    .select({ kind: schema.runs.kind })
    .from(schema.runs)
    .where(and(eq(schema.runs.campaignId, campaignId), eq(schema.runs.status, 'running')));
  const generatingProfile = runningRuns.some((r) => r.kind === 'campaign_skill_generation');
  const campaignRunning = runningRuns.some((r) => r.kind === 'campaign');

  const issues: ReadinessIssue[] = [];

  const configKeys = Object.keys((campaign.config as Record<string, unknown> | null) ?? {});
  const profileEmpty = campaign.status === 'draft' || configKeys.length === 0;

  if (generatingProfile) {
    issues.push({
      id: 'profile_generating',
      title: 'Generating campaign profile…',
      hint: 'An agent run is producing the profile right now. This usually takes a minute or two.',
      fix: { label: 'In progress', kind: 'progress' },
    });
  } else if (profileEmpty) {
    issues.push({
      id: 'profile_missing',
      title: 'Campaign profile not generated',
      hint: 'Generate the profile from an objective so the agent knows what to target.',
      fix: { label: 'Generate profile', kind: 'profile' },
    });
  } else {
    // Skill-known scenarios validate strictly; non-registered slugs are accepted as-is.
    const knownSchema = (() => {
      try {
        return getSchema(campaign.skillSlug as 'reddit-scout' | 'reddit-commenter');
      } catch {
        return null;
      }
    })();
    if (knownSchema) {
      const parsed = knownSchema.safeParse(campaign.config);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first?.path?.length ? first.path.join('.') : '(root)';
        issues.push({
          id: 'profile_invalid',
          title: 'Campaign profile is invalid',
          hint: `${where}: ${first?.message ?? 'schema mismatch'} - regenerate the profile.`,
          fix: { label: 'Regenerate profile', kind: 'profile' },
        });
      }
    }
  }

  const runnerMeta = AGENT_RUNNER_META.find((m) => m.slug === campaign.agentRunner);
  if (!runnerMeta || !runnerMeta.implemented) {
    issues.push({
      id: 'runner_unavailable',
      title: 'Agent runner not implemented',
      hint: `${campaign.agentRunner} is not a supported agent runner.`,
      fix: { label: 'Open settings', kind: 'runner', href: '/settings' },
    });
  } else {
    const detection = await detectRunner(campaign.agentRunner as AgentRunnerSlug);
    if (!detection.available) {
      issues.push({
        id: 'runner_unavailable',
        title: `${runnerMeta.label} not installed`,
        hint: detection.error ?? 'Runner CLI not detected on PATH.',
        fix: { label: 'Open settings', kind: 'runner', href: '/settings' },
      });
    }
  }

  const accounts = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.projectId, campaign.projectId));
  if (accounts.length === 0) {
    issues.push({
      id: 'no_account',
      title: 'No account linked to this project',
      hint: 'The agent needs at least one account on the target platform before it can run.',
      fix: {
        label: 'Add account',
        kind: 'accounts',
        href: `/projects/${campaign.projectId}?tab=accounts`,
      },
    });
  }

  // `profile_generating` is informational, not blocking - the campaign is
  // still "ready" if all the OTHER setup is done, so once the run finishes
  // the user can hit Run now immediately. But while it's in progress, the
  // page reads `generatingProfile` separately to disable the trigger.
  const blockingIssues = issues.filter((i) => i.id !== 'profile_generating');
  return {
    ready: blockingIssues.length === 0,
    issues,
    generatingProfile,
    campaignRunning,
  };
}
