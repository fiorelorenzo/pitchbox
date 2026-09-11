import type { OnboardingStepId } from '@pitchbox/shared/onboarding';
import { t, type Locale } from '$lib/i18n/index.js';

/**
 * Copy and destination for each onboarding step. Deliberately no form logic
 * here - every step deep-links to the page that actually does the thing
 * (rename the org, add a source, connect an account, pair the extension,
 * run a campaign) rather than duplicating that page's form on this surface.
 * Localized (LOR-263): `onboarding.step.<id>.{title,description,cta}` in
 * the dashboard catalogue, one function rather than a static record so
 * every caller reads it with the request's own locale.
 */
const STEP_IDS: readonly OnboardingStepId[] = [
  'organization',
  'verify_email',
  'project',
  'account',
  'extension',
  'first_draft',
];

export function onboardingStepMeta(
  locale: Locale | null | undefined,
  id: OnboardingStepId,
): { title: string; description: string; cta: string } {
  return {
    title: t(locale, `onboarding.step.${id}.title`),
    description: t(locale, `onboarding.step.${id}.description`),
    cta: t(locale, `onboarding.step.${id}.cta`),
  };
}

/** Every step's metadata for `locale`, for a caller that iterates all of them. */
export function onboardingStepMetaAll(
  locale: Locale | null | undefined,
): Record<OnboardingStepId, { title: string; description: string; cta: string }> {
  return Object.fromEntries(STEP_IDS.map((id) => [id, onboardingStepMeta(locale, id)])) as Record<
    OnboardingStepId,
    { title: string; description: string; cta: string }
  >;
}

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
