// Client-safe metadata for the campaign scenarios. No node imports - bundled into
// the browser via `@pitchbox/shared/campaigns`.

export type ScenarioSlug = 'reddit-scout' | 'reddit-commenter' | 'reddit-poster';

export type ScenarioMeta = {
  slug: ScenarioSlug;
  label: string;
  description: string;
  platformSlug: 'reddit';
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
];

export function getScenarioMeta(slug: ScenarioSlug): ScenarioMeta {
  const found = SCENARIO_META.find((s) => s.slug === slug);
  if (!found) throw new Error(`unknown scenario: ${slug}`);
  return found;
}
