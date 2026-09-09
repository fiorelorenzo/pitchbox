import type { OnboardingStepId } from '@pitchbox/shared/onboarding';

/**
 * Copy and destination for each onboarding step. Deliberately no form logic
 * here - every step deep-links to the page that actually does the thing
 * (rename the org, add a source, connect an account, pair the extension,
 * run a campaign) rather than duplicating that page's form on this surface.
 */
export const ONBOARDING_STEP_META: Record<
  OnboardingStepId,
  { title: string; description: string; cta: string }
> = {
  organization: {
    title: 'Name your organization',
    description:
      'It started out named after your account. Give it the name your team or company actually uses.',
    cta: 'Rename organization',
  },
  verify_email: {
    title: 'Verify your email address',
    description: 'Confirm the address on file before you can start a run.',
    cta: 'Verify email',
  },
  project: {
    title: 'Create a project with a source',
    description: 'Give the agent something to write about - a folder, a repo, or a website.',
    cta: 'Create a project',
  },
  account: {
    title: 'Connect a platform account',
    description: 'Add the Reddit, Hacker News, or Mastodon account outreach will run from.',
    cta: 'Connect an account',
  },
  extension: {
    title: 'Install the browser extension',
    description:
      'Pair it once and it will help you draft comments and detect replies on a real page.',
    cta: 'Get the extension',
  },
  first_draft: {
    title: 'Reach a first draft',
    description: 'Run a campaign and let the agent produce something for you to review.',
    cta: 'Run a campaign',
  },
};

/** Where a step's CTA goes. `firstProjectId` sharpens `account` to a
 * specific project's Accounts tab once one exists - before that, the
 * project list is the honest destination. */
export function onboardingStepHref(
  id: OnboardingStepId,
  ctx: { firstProjectId: number | null },
): string {
  switch (id) {
    case 'organization':
      return '/settings/organization';
    case 'verify_email':
      return '/settings/password';
    case 'project':
      return '/projects/new';
    case 'account':
      return ctx.firstProjectId ? `/projects/${ctx.firstProjectId}?tab=accounts` : '/projects';
    case 'extension':
      return '/settings/extension';
    case 'first_draft':
      return '/campaigns/new';
  }
}
