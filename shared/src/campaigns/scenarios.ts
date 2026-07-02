// Client-safe metadata for the campaign scenarios. No node imports - bundled into
// the browser via `@pitchbox/shared/campaigns`.

export type ScenarioSlug =
  'reddit-scout' | 'reddit-commenter' | 'reddit-poster' | 'hn-commenter' | 'hn-poster';

export type ScenarioPlatformSlug = 'reddit' | 'hackernews';

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
];

export function getScenarioMeta(slug: ScenarioSlug): ScenarioMeta {
  const found = SCENARIO_META.find((s) => s.slug === slug);
  if (!found) throw new Error(`unknown scenario: ${slug}`);
  return found;
}
