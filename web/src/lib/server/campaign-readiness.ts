import { and, eq } from 'drizzle-orm';
import { getDb, schema } from './db.js';
import { getSchema } from '@pitchbox/shared/campaigns';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { detectRunner } from '@pitchbox/shared/agents/detect';
import { t, type Locale } from '$lib/i18n/index.js';

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

/**
 * Composes each issue's title/hint/fix.label already rendered in `locale`
 * (LOR-297): this page's own copy lives in `$lib/i18n` (LOR-263), and a
 * readiness issue reaches nobody but this dashboard - no mail, no
 * extension - so it follows that same catalogue rather than
 * `@pitchbox/shared/messages`, matching the sibling "runner not
 * implemented" string `routes/campaigns/new/+page.server.ts` already
 * renders the same way. A `where`/`message`/`detail` fragment sourced from
 * a Zod validation error or a runner detection probe is passed through
 * untranslated inside the sentence, same as any other diagnostic text this
 * codebase doesn't own the wording of.
 */
export async function getCampaignReadiness(
  campaignId: number,
  locale: Locale,
): Promise<CampaignReadiness> {
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
      title: t(locale, 'campaigns.readiness.profile-generating-title'),
      hint: t(locale, 'campaigns.readiness.profile-generating-hint'),
      fix: { label: t(locale, 'campaigns.readiness.fix-in-progress'), kind: 'progress' },
    });
  } else if (profileEmpty) {
    issues.push({
      id: 'profile_missing',
      title: t(locale, 'campaigns.readiness.profile-missing-title'),
      hint: t(locale, 'campaigns.readiness.profile-missing-hint'),
      fix: { label: t(locale, 'campaigns.readiness.fix-generate-profile'), kind: 'profile' },
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
        const message = first?.message ?? t(locale, 'campaigns.readiness.schema-mismatch-fallback');
        issues.push({
          id: 'profile_invalid',
          title: t(locale, 'campaigns.readiness.profile-invalid-title'),
          hint: t(locale, 'campaigns.readiness.profile-invalid-hint', { where, message }),
          fix: { label: t(locale, 'campaigns.readiness.fix-regenerate-profile'), kind: 'profile' },
        });
      }
    }
  }

  const runnerMeta = AGENT_RUNNER_META.find((m) => m.slug === campaign.agentRunner);
  if (!runnerMeta || !runnerMeta.implemented) {
    issues.push({
      id: 'runner_unavailable',
      title: t(locale, 'campaigns.readiness.runner-not-supported-title'),
      hint: t(locale, 'campaigns.readiness.runner-not-supported-hint', {
        runner: campaign.agentRunner,
      }),
      fix: {
        label: t(locale, 'campaigns.readiness.fix-open-settings'),
        kind: 'runner',
        href: '/settings/runners',
      },
    });
  } else {
    const detection = await detectRunner(campaign.agentRunner as AgentRunnerSlug);
    if (!detection.available) {
      issues.push({
        id: 'runner_unavailable',
        title: t(locale, 'campaigns.readiness.runner-not-installed-title', {
          label: runnerMeta.label,
        }),
        hint: detection.error ?? t(locale, 'campaigns.readiness.runner-cli-not-detected'),
        fix: {
          label: t(locale, 'campaigns.readiness.fix-open-settings'),
          kind: 'runner',
          href: '/settings/runners',
        },
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
      title: t(locale, 'campaigns.readiness.no-account-title'),
      hint: t(locale, 'campaigns.readiness.no-account-hint'),
      fix: {
        label: t(locale, 'campaigns.readiness.fix-add-account'),
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
