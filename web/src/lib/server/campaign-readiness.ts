import { eq } from 'drizzle-orm';
import { getDb, schema } from './db.js';
import { getSchema } from '@pitchbox/shared/campaigns';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { detectRunner } from '@pitchbox/shared/agents/detect';

export type ReadinessIssue = {
  id: 'profile_missing' | 'profile_invalid' | 'no_account' | 'runner_unavailable';
  title: string;
  hint: string;
  fix: { label: string; kind: 'profile' | 'accounts' | 'runner'; href?: string };
};

export type CampaignReadiness = { ready: boolean; issues: ReadinessIssue[] };

export async function getCampaignReadiness(campaignId: number): Promise<CampaignReadiness> {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  if (!campaign) return { ready: false, issues: [] };

  const issues: ReadinessIssue[] = [];

  const configKeys = Object.keys((campaign.config as Record<string, unknown> | null) ?? {});
  const profileEmpty = campaign.status === 'draft' || configKeys.length === 0;

  if (profileEmpty) {
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

  return { ready: issues.length === 0, issues };
}
