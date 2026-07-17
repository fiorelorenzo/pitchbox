// Covers GH #150: the campaign create/edit UI predated HN and Mastodon, so
// POST /api/campaigns's scenarioSlug enum only accepted the reddit-* slugs and
// PATCH /api/campaigns/[id] had no way to flip campaigns.auto_post (added in
// migration 0006 for the Mastodon per-campaign auto-post feature, MAS-5).
// These tests drive the real POST/PATCH route handlers to prove hn-* and
// mastodon-* scenarios can now be created, auto_post can be set on create and
// toggled after the fact, it defaults off, and the tenant guard still applies
// to the new field.

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { POST as campaignsPost } from '../src/routes/api/campaigns/+server.js';
import { PATCH as campaignsPatch } from '../src/routes/api/campaigns/[id]/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

const PASSWORD = 'correct-horse-battery';

// Captured at import time (before `runThroughHandle` sets PITCHBOX_AUTH='on')
// so afterAll can restore it and this file doesn't leak the env var into
// other test files sharing this worker (same convention as settings-gating.test.ts).
const originalAuth = process.env.PITCHBOX_AUTH;

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Copy of seedOrgWithProject from org-isolation.test.ts / route-guards-campaigns.test.ts
// (no shared factory exists).
async function seedOrgWithProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `${slug}-proj`,
      name: `${slug} p`,
      defaultAgentRunner: 'claude-code',
    })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

async function platformId(slug: string): Promise<number> {
  const [platform] = await getDb()
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, slug));
  if (!platform) throw new Error(`platform "${slug}" is not seeded - did global-setup run?`);
  return platform.id;
}

function postEvent(orgId: number, body: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'member' } },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

function patchEvent(orgId: number, campaignId: number, body: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'member' } },
    params: { id: String(campaignId) },
    request: new Request('http://x/', { method: 'PATCH', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

// A runner slug that isn't registered in AGENT_RUNNERS: createAgentRunner
// throws synchronously before anything spawns, so dispatchRun's catch marks
// the freshly-created skill-generation run 'failed' immediately (no real
// agent process, no network, no dependency on a CLI being installed on this
// box) while POST /api/campaigns itself still returns 201 - dispatch failures
// are recorded on the run, not surfaced as a campaign-creation error.
const NO_OP_RUNNER = 'test-no-such-runner';

async function sessionFor(
  username: string,
  orgSlug: string,
  role: 'member' | 'admin' | 'owner',
): Promise<CookieJar> {
  const db = getDb();
  const hash = await hashPassword(PASSWORD);
  await db.insert(schema.users).values({ username, passwordHash: hash }).onConflictDoNothing();
  const [user] = await db
    .select()
    .from(schema.users)
    .where(sql`username = ${username}`);
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(sql`slug = ${orgSlug}`);
  await db
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user.id, role })
    .onConflictDoUpdate({
      target: [schema.memberships.organizationId, schema.memberships.userId],
      set: { role },
    });
  const session = await createSession(db, user.id);
  return { store: new Map([['pitchbox_session', { value: session.id }]]) };
}

describe('campaign scenario slugs + auto_post (#150)', () => {
  beforeEach(reset);

  describe('POST /api/campaigns accepts every seeded scenario slug', () => {
    it('creates a mastodon-scout campaign (the enum used to reject every mastodon-* slug)', async () => {
      const { orgId, projectId } = await seedOrgWithProject('csa-mastodon');
      const mastodonId = await platformId('mastodon');

      const res = await campaignsPost(
        postEvent(orgId, {
          projectId,
          platformSlug: 'mastodon',
          scenarioSlug: 'mastodon-scout',
          name: 'Mastodon scout campaign',
          agentRunner: NO_OP_RUNNER,
          objective: 'Find good-fit Mastodon users to DM about the product.',
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      const [campaign] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, body.id));
      expect(campaign.skillSlug).toBe('mastodon-scout');
      expect(campaign.platformId).toBe(mastodonId);
    });

    it('creates an hn-poster campaign (the enum also rejected reddit-poster/hn-* before this fix)', async () => {
      const { orgId, projectId } = await seedOrgWithProject('csa-hn');
      const hnId = await platformId('hackernews');

      const res = await campaignsPost(
        postEvent(orgId, {
          projectId,
          platformSlug: 'hackernews',
          scenarioSlug: 'hn-poster',
          name: 'HN poster campaign',
          agentRunner: NO_OP_RUNNER,
          objective: 'Draft a Show HN post for the product launch.',
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      const [campaign] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, body.id));
      expect(campaign.skillSlug).toBe('hn-poster');
      expect(campaign.platformId).toBe(hnId);
    });

    it('still rejects a scenario slug that is not one of the seeded scenarios', async () => {
      const { orgId, projectId } = await seedOrgWithProject('csa-bad-slug');
      const res = await campaignsPost(
        postEvent(orgId, {
          projectId,
          platformSlug: 'reddit',
          scenarioSlug: 'not-a-real-scenario',
          name: 'x',
          agentRunner: NO_OP_RUNNER,
          objective: 'x',
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('auto_post on POST /api/campaigns', () => {
    it('defaults to false when omitted', async () => {
      const { orgId, projectId } = await seedOrgWithProject('csa-default-off');
      const res = await campaignsPost(
        postEvent(orgId, {
          projectId,
          platformSlug: 'mastodon',
          scenarioSlug: 'mastodon-poster',
          name: 'Default off',
          agentRunner: NO_OP_RUNNER,
          objective: 'Draft launch toots.',
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      const [campaign] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, body.id));
      expect(campaign.autoPost).toBe(false);
    });

    it('can be set true at creation time', async () => {
      const { orgId, projectId } = await seedOrgWithProject('csa-on-create');
      const res = await campaignsPost(
        postEvent(orgId, {
          projectId,
          platformSlug: 'mastodon',
          scenarioSlug: 'mastodon-poster',
          name: 'On at create',
          agentRunner: NO_OP_RUNNER,
          objective: 'Draft launch toots.',
          autoPost: true,
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      const [campaign] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, body.id));
      expect(campaign.autoPost).toBe(true);
    });
  });

  describe('PATCH /api/campaigns/[id] toggles auto_post', () => {
    it('flips auto_post on then off and persists each change', async () => {
      const { orgId, projectId } = await seedOrgWithProject('csa-patch-toggle');
      const mastodonId = await platformId('mastodon');
      const [campaign] = await getDb()
        .insert(schema.campaigns)
        .values({
          projectId,
          platformId: mastodonId,
          name: 'toggle me',
          skillSlug: 'mastodon-poster',
          status: 'active',
          config: {},
        })
        .returning();
      expect(campaign.autoPost).toBe(false);

      const on = await campaignsPatch(patchEvent(orgId, campaign.id, { autoPost: true }));
      expect(on.status).toBe(200);
      const [afterOn] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaign.id));
      expect(afterOn.autoPost).toBe(true);

      const off = await campaignsPatch(patchEvent(orgId, campaign.id, { autoPost: false }));
      expect(off.status).toBe(200);
      const [afterOff] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaign.id));
      expect(afterOff.autoPost).toBe(false);
    });
  });

  // Same rationale as settings-gating.test.ts / instance-admin-gating.test.ts:
  // hand-injecting `locals.org` proves nothing about the tenant guard itself,
  // only about the route handler's own logic. Driving the request through the
  // real hooks.server `handle()` exercises session -> org resolution ->
  // campaignBelongsToOrg for real, so a caller who isn't a member of the
  // campaign's org (i.e. has no permission over it) is provably rejected.
  describe('PATCH auto_post permission (real handle path)', () => {
    it('a member of a different org is rejected (404) and auto_post is untouched', async () => {
      const a = await seedOrgWithProject('csa-perm-a');
      const mastodonId = await platformId('mastodon');
      const [campaign] = await getDb()
        .insert(schema.campaigns)
        .values({
          projectId: a.projectId,
          platformId: mastodonId,
          name: 'org a campaign',
          skillSlug: 'mastodon-poster',
          status: 'active',
          config: {},
        })
        .returning();

      await seedOrgWithProject('csa-perm-b');
      const jar = await sessionFor('csa-perm-member-b', 'csa-perm-b', 'member');

      const req = new Request(`http://localhost/api/campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoPost: true }),
      });
      await expect(
        runThroughHandle(req, jar, (event: any) => {
          event.params = { id: String(campaign.id) };
          return campaignsPatch(event);
        }),
      ).rejects.toMatchObject({ status: 404 });

      const [after] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaign.id));
      expect(after.autoPost).toBe(false);
    });

    it('a member of the SAME org can toggle auto_post (200) - member level, no extra role gate', async () => {
      const a = await seedOrgWithProject('csa-perm-c');
      const mastodonId = await platformId('mastodon');
      const [campaign] = await getDb()
        .insert(schema.campaigns)
        .values({
          projectId: a.projectId,
          platformId: mastodonId,
          name: 'org c campaign',
          skillSlug: 'mastodon-poster',
          status: 'active',
          config: {},
        })
        .returning();

      const jar = await sessionFor('csa-perm-member-c', 'csa-perm-c', 'member');

      const req = new Request(`http://localhost/api/campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoPost: true }),
      });
      const res = await runThroughHandle(req, jar, (event: any) => {
        event.params = { id: String(campaign.id) };
        return campaignsPatch(event);
      });
      expect(res.status).toBe(200);

      const [after] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaign.id));
      expect(after.autoPost).toBe(true);
    });
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getPool().end();
});
