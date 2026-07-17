// Client-safe metadata for the campaign scenarios. No node imports - bundled into
// the browser via `@pitchbox/shared/campaigns`.

// Single source of truth for the valid scenario slugs - mirrors the
// BUILTIN_PLAYBOOKS slugs seeded into the `playbooks` table by
// `shared/src/db/seed-core.ts`. Keep the two lists in sync.
export const SCENARIO_SLUGS = [
  'reddit-scout',
  'reddit-commenter',
  'reddit-poster',
  'hn-commenter',
  'hn-poster',
  'mastodon-scout',
  'mastodon-commenter',
  'mastodon-poster',
] as const;

export type ScenarioSlug = (typeof SCENARIO_SLUGS)[number];

export type ScenarioPlatformSlug = 'reddit' | 'hackernews' | 'mastodon';

// Platforms whose account API can post on the caller's behalf, so a campaign on
// that platform can opt into `campaigns.auto_post` (an approved draft is sent
// immediately instead of waiting for a human to send it manually). Kept in sync
// with the auto-post gate in web/src/routes/inbox/[id]/+server.ts
// (resolveMastodonAutoPost) - Mastodon only today (MAS-5).
export const AUTO_POST_PLATFORMS: ScenarioPlatformSlug[] = ['mastodon'];

export function platformSupportsAutoPost(platformSlug: string): boolean {
  return (AUTO_POST_PLATFORMS as string[]).includes(platformSlug);
}

export type ScenarioMeta = {
  slug: ScenarioSlug;
  label: string;
  description: string;
  platformSlug: ScenarioPlatformSlug;
  playbookFile: string;
};

export const SCENARIO_META: ScenarioMeta[] = [
  {
    slug: 'reddit-scout',
    label: 'Reddit DM Scout',
    description:
      'Discover Reddit users likely to be interested in the product and draft personalised DMs.',
    platformSlug: 'reddit',
    playbookFile: 'reddit-scout.md',
  },
  {
    slug: 'reddit-commenter',
    label: 'Reddit Commenter',
    description:
      'Watch target subreddits and draft helpful comment-replies that reference the product.',
    platformSlug: 'reddit',
    playbookFile: 'reddit-commenter.md',
  },
  {
    slug: 'reddit-poster',
    label: 'Reddit Poster',
    description:
      'Draft proactive top-level Reddit posts in target subreddits - title + body. Human reviews and submits.',
    platformSlug: 'reddit',
    playbookFile: 'reddit-poster.md',
  },
  {
    slug: 'hn-commenter',
    label: 'Hacker News Commenter',
    description:
      'Watch HN listings and draft substantive comment-replies on stories where the project genuinely adds value. No DMs - HN has none.',
    platformSlug: 'hackernews',
    playbookFile: 'hn-commenter.md',
  },
  {
    slug: 'hn-poster',
    label: 'Hacker News Poster',
    description:
      'Draft proactive Show HN / Ask HN / text submissions. Human reviews and submits manually.',
    platformSlug: 'hackernews',
    playbookFile: 'hn-poster.md',
  },
  {
    slug: 'mastodon-scout',
    label: 'Mastodon Scout',
    description:
      'Watch target hashtags and draft genuine, contextual DMs to good-fit posters, honoring #nobot.',
    platformSlug: 'mastodon',
    playbookFile: 'mastodon-scout.md',
  },
  {
    slug: 'mastodon-commenter',
    label: 'Mastodon Commenter',
    description: 'Draft helpful public replies to statuses that match the project.',
    platformSlug: 'mastodon',
    playbookFile: 'mastodon-commenter.md',
  },
  {
    slug: 'mastodon-poster',
    label: 'Mastodon Poster',
    description: 'Draft proactive top-level statuses (toots) for the project.',
    platformSlug: 'mastodon',
    playbookFile: 'mastodon-poster.md',
  },
];

export function getScenarioMeta(slug: ScenarioSlug): ScenarioMeta {
  const found = SCENARIO_META.find((s) => s.slug === slug);
  if (!found) throw new Error(`unknown scenario: ${slug}`);
  return found;
}
