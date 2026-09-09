import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
  loadLinkedInAssistDeviceState,
} from '@pitchbox/shared/linkedin-assist';
import { getOrgUsage } from '@pitchbox/shared/usage';
import { billingPeriodFor } from '@pitchbox/shared/org-quota';
import { POST as accept } from '../src/routes/api/extension/suggest/accept/+server.js';

/**
 * The other half of the real-time plane (#313): `/suggest` produces text
 * nobody has committed to anything yet, and this is what turns an accepted
 * suggestion into a row in the assist plane's own ledger
 * (`assist_accepted_suggestions`, #521) - no `drafts` row, no `runs` row -
 * through the same blocklist/uncontactable/dedup gates a campaign draft
 * goes through, plus an unconditional `contact_history` write, so accepting
 * something Pitchbox helped write is never invisible to contact history or
 * analytics. #523 made the project optional: an accept can name none at all
 * and still counts, filed under no product.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, contact_history, blocklist, extension_devices, assist_accepted_suggestions RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM assist_usage`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'dedup_policy'`);
}

async function seedOrgProject(slug: string, opts: { assist?: boolean } = {}) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug, description: `about ${slug}` })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  if (opts.assist ?? true) {
    await saveLinkedInAssistSettings(db, org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
    });
  }
  return { org, project, platform };
}

async function mintDevice(organizationId: number | null, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({
      organizationId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      label: 'test',
    });
}

function request(token: string | null, body: unknown) {
  return new Request('http://x/api/extension/suggest/accept', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

const POST_BODY = {
  kind: 'post_comment' as const,
  post: {
    urn: 'urn:li:activity:7000000000000000001',
    authorHandle: 'jane-doe',
    authorName: 'Jane Doe',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
  },
  body: 'We hit the same wall and cut p99 in half by batching the writes.',
  usage: {
    inputTokens: 2,
    outputTokens: 41,
    cacheReadTokens: 812,
    cacheCreationTokens: 0,
    costUsd: 0.0091,
  },
  ms: 8123,
};

describe('POST /api/extension/suggest/accept', () => {
  beforeEach(reset);

  it('refuses a request with no bearer token', async () => {
    await expect(
      accept({ request: request(null, { ...POST_BODY, projectId: 1 }) } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('404s a project outside the device org, so it leaks no other tenant ids', async () => {
    const { project: bProject } = await seedOrgProject('acc-org-b');
    const { org: orgA } = await seedOrgProject('acc-org-a');
    await mintDevice(orgA.id, 'tokA');

    await expect(
      accept({ request: request('tokA', { ...POST_BODY, projectId: bProject.id }) } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses for an org that never turned the assistant on', async () => {
    const { org, project } = await seedOrgProject('acc-off', { assist: false });
    await mintDevice(org.id, 'tokOff');

    const res = await accept({
      request: request('tokOff', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'assist_disabled' });
    expect(await getDb().select().from(schema.assistAcceptedSuggestions)).toHaveLength(0);
  });

  it('names the kill switch distinctly', async () => {
    const { org, project } = await seedOrgProject('acc-killed', { assist: false });
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
      killSwitch: true,
    });
    await mintDevice(org.id, 'tokKilled');

    const res = await accept({
      request: request('tokKilled', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'kill_switch' });
  });

  it('refuses to write as a project of the same org that is not the bound one', async () => {
    const { org, project } = await seedOrgProject('acc-bound');
    const [other] = await getDb()
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p-other', name: 'other', description: 'other' })
      .returning();
    await mintDevice(org.id, 'tokBound');

    const res = await accept({
      request: request('tokBound', { ...POST_BODY, projectId: other.id }),
    } as never);
    expect(await res.json()).toMatchObject({
      refused: 'project_not_bound',
      boundProjectId: project.id,
    });
  });

  // #523: naming no project at all makes no binding claim, so it is never a
  // bypass of the binding the way naming a *different* project of the same
  // org is (the previous test) - it is always allowed, filed under no
  // product at all.
  it('accepts a request naming no project at all, even though the org has a bound project', async () => {
    const { org, project } = await seedOrgProject('acc-no-project');
    await mintDevice(org.id, 'tokNoProject');
    const assist = await loadLinkedInAssistDeviceState(getDb(), org.id);
    expect(assist.projectId).toBe(project.id);

    const res = await accept({
      request: request('tokNoProject', POST_BODY),
    } as never);
    const body = (await res.json()) as { ok: boolean; id: number };
    expect(body.ok).toBe(true);

    const rows = await getDb().select().from(schema.assistAcceptedSuggestions);
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBeNull();
    expect(rows[0].organizationId).toBe(org.id);
  });

  it('writes exactly one ledger row and one contact_history row, carrying cache tokens through honestly', async () => {
    const { org, project, platform } = await seedOrgProject('acc-happy');
    await mintDevice(org.id, 'tokHappy');

    const res = await accept({
      request: request('tokHappy', { ...POST_BODY, projectId: project.id }),
    } as never);
    const body = (await res.json()) as { ok: boolean; id: number; dedupWarning: string | null };
    expect(body.ok).toBe(true);
    expect(body.dedupWarning).toBeNull();

    const rows = await getDb().select().from(schema.assistAcceptedSuggestions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.id,
      organizationId: org.id,
      projectId: project.id,
      platformId: platform.id,
      kind: 'post_comment',
      authorHandle: 'jane-doe',
      authorName: 'Jane Doe',
      postUrn: POST_BODY.post.urn,
      postUrl: POST_BODY.post.url,
      body: POST_BODY.body,
      editedFrom: null,
      agentRunner: 'claude-code',
      inputTokens: 2,
      outputTokens: 41,
      cacheReadTokens: 812,
      cacheCreationTokens: 0,
    });
    expect(rows[0].reportedCostUsd).toBe('0.0091');
    expect(rows[0].recomputedCostUsd).toBe('0.0009');

    // #521's own acceptance: a `contact_history` row a campaign's dedup
    // check then sees, written unconditionally at accept - no draft, no
    // send-detection event gating it.
    const contacts = await getDb().select().from(schema.contactHistory);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      platformId: platform.id,
      accountHandle: 'unknown-operator',
      targetUser: 'jane-doe',
      organizationId: org.id,
      draftId: null,
    });

    // #521: no `runs` row and no `drafts` row - the Inbox is unchanged.
    expect(await getDb().select().from(schema.runs)).toHaveLength(0);
    expect(await getDb().select().from(schema.drafts)).toHaveLength(0);
  });

  it('keeps editedFrom only when the human actually changed the text before accepting', async () => {
    const { org, project } = await seedOrgProject('acc-edited');
    await mintDevice(org.id, 'tokEdited');

    const sameText = await accept({
      request: request('tokEdited', {
        ...POST_BODY,
        projectId: project.id,
        editedFrom: POST_BODY.body,
      }),
    } as never);
    expect((await sameText.json() as { ok: boolean }).ok).toBe(true);

    const changed = await accept({
      request: request('tokEdited', {
        ...POST_BODY,
        post: { ...POST_BODY.post, urn: 'urn:li:activity:7000000000000000002' },
        projectId: project.id,
        editedFrom: 'The model\u2019s own draft text, before the human touched it.',
      }),
    } as never);
    expect((await changed.json() as { ok: boolean }).ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(schema.assistAcceptedSuggestions)
      .orderBy(schema.assistAcceptedSuggestions.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].editedFrom).toBeNull();
    expect(rows[1].editedFrom).toBe('The model\u2019s own draft text, before the human touched it.');
  });

  // A feed post carries no URN at all (docs/linkedin-integration-design.md,
  // "Two frontends, one identifier"). The honest response is to record what
  // the panel actually saw rather than invent an id.
  it('accepts a feed post with no urn, recording an honest author-only identifier', async () => {
    const { org, project } = await seedOrgProject('acc-no-urn');
    await mintDevice(org.id, 'tokNoUrn');

    const postWithoutUrn = {
      authorHandle: POST_BODY.post.authorHandle,
      authorName: POST_BODY.post.authorName,
      url: POST_BODY.post.url,
    };
    const res = await accept({
      request: request('tokNoUrn', { ...POST_BODY, post: postWithoutUrn, projectId: project.id }),
    } as never);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);

    const [row] = await getDb().select().from(schema.assistAcceptedSuggestions);
    expect(row.postUrn).toBeNull();
    expect(row.postUrl).toBe(postWithoutUrn.url);
    expect(row.authorHandle).toBe('jane-doe');
  });

  // A `post` has no target of its own (the human's own content, not a reply
  // to anyone) - no blocklist/dedup check applies, and no contact_history
  // row is written, since there is no contact to record.
  it('a post kind with no target writes the ledger row but no contact_history row', async () => {
    const { org, project } = await seedOrgProject('acc-post-kind');
    await mintDevice(org.id, 'tokPostKind');

    const res = await accept({
      request: request('tokPostKind', {
        kind: 'post' as const,
        post: {},
        body: 'A specific thing that happened this week.',
        platform: 'linkedin',
        projectId: project.id,
      }),
    } as never);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);

    expect(await getDb().select().from(schema.assistAcceptedSuggestions)).toHaveLength(1);
    expect(await getDb().select().from(schema.contactHistory)).toHaveLength(0);
  });

  describe('the checks a campaign draft goes through (#521)', () => {
    // Each of these is proven, not merely asserted: with the corresponding
    // check commented out in shared/src/assist-accept.ts, the exact test
    // named in its comment failed before the check was restored.

    // Proven: removing the `isBlocklisted` call in acceptSuggestion made
    // this test's `refused` assertion fail (the accept succeeded and wrote
    // a ledger row instead).
    it('refuses a blocklisted target with no ledger row and no contact_history row', async () => {
      const { org, project, platform } = await seedOrgProject('acc-blocked');
      await mintDevice(org.id, 'tokBlocked');
      await getDb()
        .insert(schema.blocklist)
        .values({ platformId: platform.id, kind: 'user', value: 'jane-doe', scope: 'global' });

      const res = await accept({
        request: request('tokBlocked', { ...POST_BODY, projectId: project.id }),
      } as never);
      expect(await res.json()).toMatchObject({ refused: 'blocked' });
      expect(await getDb().select().from(schema.assistAcceptedSuggestions)).toHaveLength(0);
      expect(await getDb().select().from(schema.contactHistory)).toHaveLength(0);
    });

    // Proven: removing the keyword-blocklist call made this test's
    // `refused` assertion fail the same way.
    it('refuses a keyword-blocklisted body with no ledger row', async () => {
      const { org, project, platform } = await seedOrgProject('acc-keyword-blocked');
      await mintDevice(org.id, 'tokKeywordBlocked');
      await getDb().insert(schema.blocklist).values({
        platformId: platform.id,
        kind: 'keyword',
        value: 'batching the writes',
        scope: 'global',
      });

      const res = await accept({
        request: request('tokKeywordBlocked', { ...POST_BODY, projectId: project.id }),
      } as never);
      expect(await res.json()).toMatchObject({ refused: 'blocked' });
      expect(await getDb().select().from(schema.assistAcceptedSuggestions)).toHaveLength(0);
    });

    // Proven: removing the `checkContactDedup` skip-mode branch made this
    // test's `refused` assertion fail (the accept went through instead).
    it('refuses a recently-contacted target with no ledger row, when the dedup policy is set to skip', async () => {
      const { org, project, platform } = await seedOrgProject('acc-dedup-skip');
      await mintDevice(org.id, 'tokDedupSkip');
      await getDb()
        .insert(schema.appConfig)
        .values({ key: 'dedup_policy', value: { window_days: 90, mode: 'skip' } });
      await getDb().insert(schema.contactHistory).values({
        platformId: platform.id,
        accountHandle: 'unknown-operator',
        targetUser: 'jane-doe',
        organizationId: org.id,
        lastContactedAt: new Date(),
      });

      const res = await accept({
        request: request('tokDedupSkip', { ...POST_BODY, projectId: project.id }),
      } as never);
      expect(await res.json()).toMatchObject({ refused: 'recently_contacted' });
      expect(await getDb().select().from(schema.assistAcceptedSuggestions)).toHaveLength(0);
      // Only the seeded contact_history row exists - the refused accept
      // added none of its own.
      expect(await getDb().select().from(schema.contactHistory)).toHaveLength(1);
    });

    // The default policy mode is 'warn', not 'skip': a repeat contact is
    // still accepted, carrying a warning rather than a refusal, and still
    // writes a second contact_history row.
    it('warns rather than refuses a recently-contacted target under the default (warn) policy', async () => {
      const { org, project, platform } = await seedOrgProject('acc-dedup-warn');
      await mintDevice(org.id, 'tokDedupWarn');
      await getDb().insert(schema.contactHistory).values({
        platformId: platform.id,
        accountHandle: 'unknown-operator',
        targetUser: 'jane-doe',
        organizationId: org.id,
        lastContactedAt: new Date(),
      });

      const res = await accept({
        request: request('tokDedupWarn', { ...POST_BODY, projectId: project.id }),
      } as never);
      const body = (await res.json()) as { ok: boolean; dedupWarning: string | null };
      expect(body.ok).toBe(true);
      expect(body.dedupWarning).toMatch(/Previously contacted on/);

      expect(await getDb().select().from(schema.assistAcceptedSuggestions)).toHaveLength(1);
      expect(await getDb().select().from(schema.contactHistory)).toHaveLength(2);
    });
  });

  // Issue #521's own acceptance: "the Inbox is unchanged afterwards."
  // Proven: temporarily reintroducing a `drafts` insert into
  // acceptSuggestion (the exact shape the old draft-materialising path
  // used) made this test's `toHaveLength(0)` assertion fail.
  it('leaves the Inbox (the drafts table) untouched by an accept, per #521', async () => {
    const { org, project } = await seedOrgProject('acc-inbox-unchanged');
    await mintDevice(org.id, 'tokInboxUnchanged');

    await accept({
      request: request('tokInboxUnchanged', { ...POST_BODY, projectId: project.id }),
    } as never);

    expect(await getDb().select().from(schema.drafts)).toHaveLength(0);
    expect(await getDb().select().from(schema.runs)).toHaveLength(0);
  });

  // #523's own acceptance for the accept path: a no-project accept works
  // end to end, and is counted by getOrgUsage exactly once - through the
  // suggestion it followed, never through the accept itself (accepting
  // writes no assist_usage row of its own).
  it('a no-project accept is counted by getOrgUsage exactly once, through the suggestion that preceded it', async () => {
    const savedEdition = process.env.PITCHBOX_EDITION;
    process.env.PITCHBOX_EDITION = 'cloud';
    try {
      const { org, platform } = await seedOrgProject('acc-usage-once');
      await mintDevice(org.id, 'tokUsageOnce');

      // The suggestion that produced this text already ledgered its own
      // spend (web/src/routes/api/extension/suggest/+server.ts), with no
      // project - #523 made assist_usage.project_id nullable for exactly
      // this case.
      await getDb().insert(schema.assistUsage).values({
        organizationId: org.id,
        projectId: null,
        deviceId: null,
        platformId: platform.id,
        kind: 'post_comment',
        agentRunner: 'claude-code',
      });

      const res = await accept({
        request: request('tokUsageOnce', POST_BODY),
      } as never);
      expect((await res.json() as { ok: boolean }).ok).toBe(true);

      const period = await billingPeriodFor(getDb(), org.id);
      const usage = await getOrgUsage(getDb(), org.id, period);
      // One suggestion produced, one accepted - the accept must not add a
      // second count on top of the suggestion it followed.
      expect(usage.suggestions.used).toBe(1);
    } finally {
      if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
      else process.env.PITCHBOX_EDITION = savedEdition;
    }
  });

  describe('org isolation (two organizations, not one)', () => {
    it("never lets org A's blocklist refuse org B's identical target", async () => {
      const { org: orgA, project: projectA, platform } = await seedOrgProject('acc-iso-a');
      const { org: orgB, project: projectB } = await seedOrgProject('acc-iso-b');
      await mintDevice(orgA.id, 'tokIsoA');
      await mintDevice(orgB.id, 'tokIsoB');
      await getDb().insert(schema.blocklist).values({
        platformId: platform.id,
        kind: 'user',
        value: 'jane-doe',
        scope: 'project',
        projectId: projectA.id,
      });

      const refusedA = await accept({
        request: request('tokIsoA', { ...POST_BODY, projectId: projectA.id }),
      } as never);
      expect(await refusedA.json()).toMatchObject({ refused: 'blocked' });

      const okB = await accept({
        request: request('tokIsoB', { ...POST_BODY, projectId: projectB.id }),
      } as never);
      expect((await okB.json() as { ok: boolean }).ok).toBe(true);
    });

    it("never lets org A's contact history warn on org B's identical target", async () => {
      const { org: orgA, project: projectA, platform } = await seedOrgProject('acc-iso-dedup-a');
      const { org: orgB, project: projectB } = await seedOrgProject('acc-iso-dedup-b');
      await mintDevice(orgA.id, 'tokIsoDedupA');
      await mintDevice(orgB.id, 'tokIsoDedupB');
      await getDb().insert(schema.contactHistory).values({
        platformId: platform.id,
        accountHandle: 'unknown-operator',
        targetUser: 'jane-doe',
        organizationId: orgA.id,
        lastContactedAt: new Date(),
      });

      const resB = await accept({
        request: request('tokIsoDedupB', { ...POST_BODY, projectId: projectB.id }),
      } as never);
      const bodyB = (await resB.json()) as { ok: boolean; dedupWarning: string | null };
      expect(bodyB.ok).toBe(true);
      expect(bodyB.dedupWarning).toBeNull();
    });

    it("counts each organization's accepted suggestions separately in getOrgUsage", async () => {
      const savedEdition = process.env.PITCHBOX_EDITION;
      process.env.PITCHBOX_EDITION = 'cloud';
      try {
        const { org: orgA, project: projectA, platform } = await seedOrgProject('acc-iso-usage-a');
        const { org: orgB } = await seedOrgProject('acc-iso-usage-b');
        await mintDevice(orgA.id, 'tokIsoUsageA');
        await getDb().insert(schema.assistUsage).values({
          organizationId: orgA.id,
          projectId: projectA.id,
          deviceId: null,
          platformId: platform.id,
          kind: 'post_comment',
          agentRunner: 'claude-code',
        });
        await getDb().insert(schema.assistUsage).values({
          organizationId: orgB.id,
          projectId: null,
          deviceId: null,
          platformId: platform.id,
          kind: 'post_comment',
          agentRunner: 'claude-code',
        });

        const periodA = await billingPeriodFor(getDb(), orgA.id);
        const usageA = await getOrgUsage(getDb(), orgA.id, periodA);
        expect(usageA.suggestions.used).toBe(1);

        const periodB = await billingPeriodFor(getDb(), orgB.id);
        const usageB = await getOrgUsage(getDb(), orgB.id, periodB);
        expect(usageB.suggestions.used).toBe(1);
      } finally {
        if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
        else process.env.PITCHBOX_EDITION = savedEdition;
      }
    });
  });
});
