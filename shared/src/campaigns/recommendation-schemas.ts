import { z } from 'zod';

export const RecommendationItemSchema = z
  .object({
    scenarioSlug: z.enum([
      'reddit-scout',
      'reddit-commenter',
      'reddit-poster',
      'hn-commenter',
      'hn-poster',
    ]),
    name: z.string().min(1).max(120),
    objective: z.string().min(1).max(2000),
  })
  .strict();

export type RecommendationItem = z.infer<typeof RecommendationItemSchema>;
