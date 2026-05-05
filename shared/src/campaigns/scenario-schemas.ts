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
        productUrl: z.string().url(),
        subject: z.string().min(1).max(120),
        text: z.string().min(1),
      })
      .strict(),
    systemInstructions: z.string().min(1),
  })
  .strict();

const RedditCommenterSchema = z
  .object({
    targetSubreddits: z.array(z.string().min(1)).min(1),
    topicKeywords: z.array(z.string().min(1)),
    avoidKeywords: z.array(z.string().min(1)),
    voice: z
      .object({
        tone: z.enum(['casual', 'neutral', 'professional']),
        hardBans: z.array(z.string()),
        dos: z.array(z.string()),
        disclosure: z.string().min(1),
      })
      .strict(),
    valuePropositions: z.array(z.string().min(1)),
    productUrl: z.string().url(),
    systemInstructions: z.string().min(1),
  })
  .strict();

export const SCENARIO_SCHEMAS = {
  'reddit-scout': RedditScoutSchema,
  'reddit-commenter': RedditCommenterSchema,
} as const;

export type CampaignProfile<S extends ScenarioSlug> = z.infer<(typeof SCENARIO_SCHEMAS)[S]>;

export function getSchema(slug: ScenarioSlug) {
  return SCENARIO_SCHEMAS[slug];
}
