import { z } from 'zod';
import type { ScenarioSlug } from './scenarios.js';

const RedditScoutSchema = z
  .object({
    targetSubreddits: z.array(z.string().min(1)).min(1),
    topicKeywords: z.array(z.string().min(1)),
    avoidKeywords: z.array(z.string().min(1)),
    fitScoreThreshold: z.number().int().min(1).max(5),
    voice: z
      .object({
        tone: z.enum(['casual', 'neutral', 'professional']),
        hardBans: z.array(z.string()),
        dos: z.array(z.string()),
        openerStyle: z.enum(['lowercase-casual', 'question-led', 'observational']),
        disclosure: z.string().min(1),
      })
      .strict(),
    offer: z
      .object({
        productUrl: z.url(),
        subject: z.string().min(1).max(120),
        text: z.string().min(1),
      })
      .strict(),
    systemInstructions: z.string().min(1),
    // Posts older than this are dropped as stale at collection time (#338).
    // Optional and deliberately left out of the generator's instructions -
    // see campaign-skill-generator.md step 2 - so the scout falls back to
    // its own default (72h) instead of an LLM-guessed per-campaign value.
    maxPostAgeHours: z.number().int().positive().optional(),
  })
  .strict();

const draftingVoiceShape = {
  tone: z.enum(['casual', 'neutral', 'professional']),
  hardBans: z.array(z.string()),
  dos: z.array(z.string()),
  disclosure: z.string().min(1),
  // LOR-265: an explicit per-campaign language pin, next to `tone`. Every
  // drafting scenario below shares this shape, so a pin is spelled and
  // validated identically regardless of platform - the same discipline
  // classifyLanguage/checkStyle already apply to `en`/`it`, the only two
  // languages this product's language tooling actually knows. Absent, the
  // playbook defaults to the language of the post/thread it answers (or,
  // for a proactive post, the operator's own corpus) - never a setting.
  // Left off reddit-scout's own voice above: a scout stages candidates, it
  // never drafts final text, so there is nothing here for a pin to govern.
  language: z.enum(['en', 'it']).optional(),
};

const RedditCommenterSchema = z
  .object({
    targetSubreddits: z.array(z.string().min(1)).min(1),
    topicKeywords: z.array(z.string().min(1)),
    avoidKeywords: z.array(z.string().min(1)),
    voice: z.object(draftingVoiceShape).strict(),
    valuePropositions: z.array(z.string().min(1)),
    productUrl: z.url(),
    systemInstructions: z.string().min(1),
  })
  .strict();

const RedditPosterSchema = z
  .object({
    targetSubreddits: z.array(z.string().min(1)).min(1),
    topicKeywords: z.array(z.string().min(1)),
    avoidKeywords: z.array(z.string().min(1)),
    postAngle: z.string().min(1),
    voice: z.object(draftingVoiceShape).strict(),
    valuePropositions: z.array(z.string().min(1)),
    productUrl: z.url(),
    systemInstructions: z.string().min(1),
  })
  .strict();

const HnListingEnum = z.enum(['top', 'new', 'best', 'ask', 'show']);

const HnCommenterSchema = z
  .object({
    listing: HnListingEnum,
    topicKeywords: z.array(z.string().min(1)),
    avoidKeywords: z.array(z.string().min(1)),
    voice: z.object(draftingVoiceShape).strict(),
    valuePropositions: z.array(z.string().min(1)),
    productUrl: z.url(),
    systemInstructions: z.string().min(1),
  })
  .strict();

const HnPosterSchema = z
  .object({
    postAngle: z.string().min(1),
    format: z.enum(['show-hn', 'ask-hn', 'text']).optional(),
    topicKeywords: z.array(z.string().min(1)),
    avoidKeywords: z.array(z.string().min(1)),
    voice: z.object(draftingVoiceShape).strict(),
    valuePropositions: z.array(z.string().min(1)),
    productUrl: z.url(),
    systemInstructions: z.string().min(1),
  })
  .strict();

export const SCENARIO_SCHEMAS = {
  'reddit-scout': RedditScoutSchema,
  'reddit-commenter': RedditCommenterSchema,
  'reddit-poster': RedditPosterSchema,
  'hn-commenter': HnCommenterSchema,
  'hn-poster': HnPosterSchema,
} as const;

export type CampaignProfile<S extends keyof typeof SCENARIO_SCHEMAS> = z.infer<
  (typeof SCENARIO_SCHEMAS)[S]
>;

// Not every scenario has a registered structured schema yet (e.g. the
// mastodon-* scenarios, whose profile shape isn't defined here) - a call with
// a literal key of SCENARIO_SCHEMAS is guaranteed a schema back, but a call
// with the wider ScenarioSlug type may return undefined and callers must
// handle that (treat it as "no strict validation for this scenario" rather
// than throwing, matching getCampaignReadiness's "accepted as-is" behaviour).
// A single generic + conditional return type (rather than overload
// signatures) gets the same narrowing without redeclaring the function.
export function getSchema<S extends ScenarioSlug>(
  slug: S,
): S extends keyof typeof SCENARIO_SCHEMAS ? (typeof SCENARIO_SCHEMAS)[S] : undefined {
  return (SCENARIO_SCHEMAS as Record<string, unknown>)[slug] as never;
}
