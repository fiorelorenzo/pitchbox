import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { acceptSuggestion } from '../src/assist-accept.js';

/**
 * `acceptSuggestion` (shared/src/assist-accept.ts) walks the same gates
 * `cli/src/commands/drafts.ts`'s `createDrafts` applies to a campaign draft:
 * blocklist, keyword blocklist, contact dedup and `checkUncontactable`. The
 * web route suite (web/tests/extension-suggest-accept.test.ts) proves all of
 * those except one - `checkUncontactable` only fires for `kind: 'dm'`, and
 * the extension route's own BodySchema (web/src/routes/api/extension/
 * suggest/accept/+server.ts) never allows `dm` through, since LinkedIn
 * ships no DM scenario. This file calls `acceptSuggestion` directly to reach
 * it, and covers nothing already proved by the route suite.
 */

async function platformId(slug: string) {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

async function ensureOrg(slug: string) {
  const db = getDb();
  await db.insert(schema.organizations).values({ slug, name: slug }).onConflictDoNothing();
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug));
  return org!.id;
}

function baseInput(overrides: {
  organizationId: number;
  platformId: number;
  authorHandle: string;
}) {
  return {
    organizationId: overrides.organizationId,
    projectId: null,
    platformId: overrides.platformId,
    kind: 'dm' as const,
    authorHandle: overrides.authorHandle,
    authorName: 'Target Person',
    postUrn: null,
    postUrl: null,
    body: 'Following up on our thread.',
    deviceId: null,
    agentRunner: 'claude-code',
    usage: null,
  };
}

describe('acceptSuggestion: uncontactable (#521, #335)', () => {
  beforeEach(async () => {
    await getDb().execute(
      sql`TRUNCATE contact_history, assist_accepted_suggestions RESTART IDENTITY CASCADE`,
    );
  });

  it('refuses a dm to a target already marked uncontactable', async () => {
    const organizationId = await ensureOrg('assist-accept-uncontactable');
    const platform = await platformId('linkedin');
    await getDb().insert(schema.contactHistory).values({
      platformId: platform,
      accountHandle: 'operator',
      targetUser: 'closed-inbox',
      organizationId,
      uncontactable: true,
      uncontactableReason: 'unable to send a message request to this account',
    });

    const result = await acceptSuggestion(
      getDb(),
      baseInput({ organizationId, platformId: platform, authorHandle: 'closed-inbox' }),
    );

    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: 'uncontactable',
        detail: 'unable to send a message request to this account',
      },
    });

    const rows = await getDb().select().from(schema.assistAcceptedSuggestions);
    expect(rows).toHaveLength(0);
  });

  it('accepts a dm to a target with no uncontactable history', async () => {
    const organizationId = await ensureOrg('assist-accept-contactable');
    const platform = await platformId('linkedin');

    const result = await acceptSuggestion(
      getDb(),
      baseInput({ organizationId, platformId: platform, authorHandle: 'open-inbox' }),
    );

    expect(result.ok).toBe(true);
  });

  it('does not treat an uncontactable target on another organization as uncontactable here', async () => {
    const org = await ensureOrg('assist-accept-uncontactable-org-a');
    const otherOrg = await ensureOrg('assist-accept-uncontactable-org-b');
    const platform = await platformId('linkedin');
    await getDb().insert(schema.contactHistory).values({
      platformId: platform,
      accountHandle: 'operator',
      targetUser: 'shared-handle',
      organizationId: otherOrg,
      uncontactable: true,
      uncontactableReason: 'blocked on the other org',
    });

    const result = await acceptSuggestion(
      getDb(),
      baseInput({ organizationId: org, platformId: platform, authorHandle: 'shared-handle' }),
    );

    expect(result.ok).toBe(true);
  });
});
