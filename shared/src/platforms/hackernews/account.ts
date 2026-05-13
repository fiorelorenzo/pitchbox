import { z } from 'zod';

/**
 * Hacker News doesn't have an official auth API for outreach. Pitchbox only
 * tracks the username - the human signs in to HN in their browser and the
 * extension/CLI never needs a secret. No DM support: HN provides no private
 * messaging primitive, so comment outreach is the only mode.
 */
export const HN_ACCOUNT_SCHEMA = z.object({
  username: z.string().min(1, 'username is required'),
});

export type HnAccountFields = z.infer<typeof HN_ACCOUNT_SCHEMA>;

export function getAccountSchema(): typeof HN_ACCOUNT_SCHEMA {
  return HN_ACCOUNT_SCHEMA;
}
