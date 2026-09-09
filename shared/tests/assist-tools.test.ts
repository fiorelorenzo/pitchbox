import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import {
  ASSIST_TOOLS,
  ASSIST_TOOLS_BY_NAME,
  type AssistToolContext,
  type AssistObservedTarget,
} from '../src/assist/tools.js';
import { recordVoiceSamples } from '../src/operator-profile.js';

// #567: the seven assist tool handlers. What matters here is what a pure
// unit test cannot check on its own - real org-scoped queries against real
// tables - and the refusal contract every tool follows: an explicit nothing
// (`{ ok: false, reason }`), never an empty success, when there is nothing
// to say.

async function reset() {
  await getDb().execute(
    sql`TRUNCATE operator_voice_profiles, operator_voice_samples, operator_profiles,
      messages, contact_history, drafts, runs, campaigns, templates, accounts,
      project_insights, github_sources, blocklist, projects
      RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function ensureOrg(slug: string): Promise<number> {
  const db = getDb();
  await db.insert(schema.organizations).values({ slug, name: slug }).onConflictDoNothing();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug));
  return org!.id;
}

async function platformId(slug: string): Promise<number> {
  const [p] = await getDb().select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

async function makeProject(orgId: number, slug: string, description?: string): Promise<number> {
  const [p] = await getDb()
    .insert(schema.projects)
    .values({ organizationId: orgId, slug, name: slug, description })
    .returning({ id: schema.projects.id });
  return p!.id;
}

function baseCtx(
  overrides: Partial<AssistToolContext> & { orgId: number; boundProjectId: number },
): AssistToolContext {
  return { db: getDb(), observedTarget: null, operator: null, ...overrides };
}

describe('shared/src/assist/tools', () => {
  beforeEach(reset);

  describe('read_thread', () => {
    it('refuses with an explicit nothing when no thread was captured', async () => {
      const ctx = baseCtx({ orgId: 1, boundProjectId: 1, observedTarget: null });
      const result = await ASSIST_TOOLS_BY_NAME.read_thread.handler(ctx, {});
      expect(result.ok).toBe(false);
    });

    it('returns the post and the visible comment thread, clamp marked false when nothing was cut', async () => {
      const observedTarget: AssistObservedTarget = {
        authorHandle: 'jdoe',
        authorName: 'Jane Doe',
        text: 'Hello world',
        thread: {
          comments: [
            {
              id: 'c1',
              authorHandle: 'bob',
              authorName: 'Bob',
              body: 'nice post',
              relativeTime: '2h',
            },
          ],
          renderedCount: 1,
          truncated: false,
        },
      };
      const ctx = baseCtx({ orgId: 1, boundProjectId: 1, observedTarget });
      const result = await ASSIST_TOOLS_BY_NAME.read_thread.handler(ctx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.post.text).toBe('Hello world');
      expect(result.data.post.author.handle).toBe('jdoe');
      expect(result.data.comments).toHaveLength(1);
      expect(result.data.comments[0].body).toBe('nice post');
      expect(result.data.clamp).toEqual({ textTruncated: false, commentsTruncated: false });
    });

    it('marks the clamp when the extension-reported thread was already truncated', async () => {
      const observedTarget: AssistObservedTarget = {
        text: 'Hello world',
        thread: { comments: [], renderedCount: 40, truncated: true },
      };
      const ctx = baseCtx({ orgId: 1, boundProjectId: 1, observedTarget });
      const result = await ASSIST_TOOLS_BY_NAME.read_thread.handler(ctx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.clamp.commentsTruncated).toBe(true);
    });
  });

  describe('look_at_image', () => {
    it('refuses with an explicit nothing when the post has no image at all', async () => {
      const ctx = baseCtx({
        orgId: 1,
        boundProjectId: 1,
        observedTarget: { text: 'no image here' },
      });
      const result = await ASSIST_TOOLS_BY_NAME.look_at_image.handler(ctx, {});
      expect(result.ok).toBe(false);
    });

    it('refuses with an explicit nothing when the image exists but nothing was captured', async () => {
      const ctx = baseCtx({
        orgId: 1,
        boundProjectId: 1,
        observedTarget: { text: 'x', image: { kind: 'image' } },
      });
      const result = await ASSIST_TOOLS_BY_NAME.look_at_image.handler(ctx, {});
      expect(result.ok).toBe(false);
    });

    it('describes from alt text with no model call when only alt text is present', async () => {
      const ctx = baseCtx({
        orgId: 1,
        boundProjectId: 1,
        observedTarget: {
          text: 'x',
          image: { kind: 'image', alt: 'A bar chart showing quarterly growth' },
        },
      });
      const result = await ASSIST_TOOLS_BY_NAME.look_at_image.handler(ctx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.source).toBe('alt_text');
      expect(result.data.description).toContain('bar chart');
      expect(result.data.usage).toBeUndefined();
    });

    it('refuses with an explicit nothing rather than throwing when no Gateway key is configured', async () => {
      const previous = process.env.AI_GATEWAY_API_KEY;
      delete process.env.AI_GATEWAY_API_KEY;
      try {
        const ctx = baseCtx({
          orgId: 1,
          boundProjectId: 1,
          observedTarget: {
            text: 'x',
            image: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' },
          },
        });
        const result = await ASSIST_TOOLS_BY_NAME.look_at_image.handler(ctx, {});
        expect(result.ok).toBe(false);
      } finally {
        if (previous !== undefined) process.env.AI_GATEWAY_API_KEY = previous;
      }
    });
  });

  describe('author_history', () => {
    it("never returns another organization's contact rows - org scoping", async () => {
      const orgA = await ensureOrg('at-org-a');
      const orgB = await ensureOrg('at-org-b');
      const linkedin = await platformId('linkedin');
      await getDb()
        .insert(schema.contactHistory)
        .values({
          platformId: linkedin,
          accountHandle: 'acct-a',
          targetUser: 'shared-handle',
          organizationId: orgA,
          repliedAt: new Date('2026-01-01T00:00:00Z'),
        });
      await getDb()
        .insert(schema.contactHistory)
        .values({
          platformId: linkedin,
          accountHandle: 'acct-b',
          targetUser: 'shared-handle',
          organizationId: orgB,
          repliedAt: new Date('2026-06-01T00:00:00Z'),
          uncontactable: true,
          uncontactableReason: "org B's own private fact",
        });
      const projA = await makeProject(orgA, 'at-proj-a');
      const ctx = baseCtx({
        orgId: orgA,
        boundProjectId: projA,
        observedTarget: { authorHandle: 'shared-handle', text: 'x' },
      });
      const result = await ASSIST_TOOLS_BY_NAME.author_history.handler(ctx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.repliedAt).toBe(new Date('2026-01-01T00:00:00Z').toISOString());
      expect(result.data.uncontactable).toBe(false);
      expect(result.data.uncontactableReason).toBeNull();
    });

    it('refuses with an explicit nothing when there is no prior contact', async () => {
      const orgA = await ensureOrg('at-org-empty');
      const projA = await makeProject(orgA, 'at-proj-empty');
      const ctx = baseCtx({
        orgId: orgA,
        boundProjectId: projA,
        observedTarget: { authorHandle: 'nobody-seen-before', text: 'x' },
      });
      const result = await ASSIST_TOOLS_BY_NAME.author_history.handler(ctx, {});
      expect(result.ok).toBe(false);
    });

    it('surfaces a blocklisted handle even with no contact history on file', async () => {
      const orgA = await ensureOrg('at-org-blocked');
      const projA = await makeProject(orgA, 'at-proj-blocked');
      const linkedin = await platformId('linkedin');
      await getDb().insert(schema.blocklist).values({
        platformId: linkedin,
        kind: 'user',
        value: 'spammer',
        scope: 'global',
        reason: 'asked not to be pitched',
      });
      const ctx = baseCtx({
        orgId: orgA,
        boundProjectId: projA,
        observedTarget: { authorHandle: 'spammer', text: 'x' },
      });
      const result = await ASSIST_TOOLS_BY_NAME.author_history.handler(ctx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.blocked).toBe(true);
      expect(result.data.blockedReason).toBe('asked not to be pitched');
      expect(result.data.contactedBefore).toBe(false);
    });

    it('refuses with an explicit nothing when the captured post has no author handle', async () => {
      const ctx = baseCtx({
        orgId: 1,
        boundProjectId: 1,
        observedTarget: { text: 'no author here' },
      });
      const result = await ASSIST_TOOLS_BY_NAME.author_history.handler(ctx, {});
      expect(result.ok).toBe(false);
    });
  });

  describe('operator_voice', () => {
    it('reports an honest default, never an invented voice, when the corpus is thin', async () => {
      const orgA = await ensureOrg('ov-org-thin');
      const ctx = baseCtx({ orgId: orgA, boundProjectId: 1 });
      const result = await ASSIST_TOOLS_BY_NAME.operator_voice.handler(ctx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.voice.status).toBe('default');
      expect(result.data.voice.itemCount).toBe(0);
      expect(result.data.persona).toBeNull();
    });

    it('always answers - never refuses, even with nothing on file', async () => {
      const orgA = await ensureOrg('ov-org-never-refuses');
      const ctx = baseCtx({ orgId: orgA, boundProjectId: 1 });
      const result = await ASSIST_TOOLS_BY_NAME.operator_voice.handler(ctx, {});
      expect(result.ok).toBe(true);
    });
  });

  describe('project_knowledge', () => {
    it('refuses a project id that is neither the bound project nor the personal project', async () => {
      const orgA = await ensureOrg('pk-org-a');
      const projBound = await makeProject(orgA, 'pk-bound');
      const projOther = await makeProject(orgA, 'pk-other');
      const ctx = baseCtx({ orgId: orgA, boundProjectId: projBound });
      const result = await ASSIST_TOOLS_BY_NAME.project_knowledge.handler(ctx, {
        projectId: projOther,
      });
      expect(result.ok).toBe(false);
    });

    it("refuses another organization's project id even though it is a valid row", async () => {
      const orgA = await ensureOrg('pk-org-x');
      const orgB = await ensureOrg('pk-org-y');
      const projBoundA = await makeProject(orgA, 'pk-bound-a');
      const projB = await makeProject(orgB, 'pk-proj-b', "org B's own product");
      const ctx = baseCtx({ orgId: orgA, boundProjectId: projBoundA });
      const result = await ASSIST_TOOLS_BY_NAME.project_knowledge.handler(ctx, {
        projectId: projB,
      });
      expect(result.ok).toBe(false);
    });

    it('answers for the bound project with its description', async () => {
      const orgA = await ensureOrg('pk-org-b');
      const projBound = await makeProject(orgA, 'pk-bound2', 'A product that does X');
      const ctx = baseCtx({ orgId: orgA, boundProjectId: projBound });
      const result = await ASSIST_TOOLS_BY_NAME.project_knowledge.handler(ctx, {
        projectId: projBound,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.project.description).toBe('A product that does X');
    });

    // #523 retired the personal project and, with it, project_knowledge's
    // bypass for it - a non-bound project id now always refuses, no
    // exceptions. Deleted rather than re-pinned to a plain seeded project:
    // the behaviour this test defended (a distinguished project id that
    // skips the binding check) no longer exists in the handler at all, and
    // the two tests above already cover the real current contract (a bound
    // project answers, any other one refuses).
    it('refuses with an explicit nothing when the project has no description, repos or insights', async () => {
      const orgA = await ensureOrg('pk-org-empty');
      const projBound = await makeProject(orgA, 'pk-bound-empty');
      const ctx = baseCtx({ orgId: orgA, boundProjectId: projBound });
      const result = await ASSIST_TOOLS_BY_NAME.project_knowledge.handler(ctx, {
        projectId: projBound,
      });
      expect(result.ok).toBe(false);
    });

    it("never returns another organization's github repos - org scoping", async () => {
      const orgA = await ensureOrg('pk-org-repo-a');
      const orgB = await ensureOrg('pk-org-repo-b');
      await getDb().insert(schema.githubSources).values({
        organizationId: orgB,
        owner: 'org-b-owner',
        repo: 'org-b-repo',
        url: 'https://github.com/org-b-owner/org-b-repo',
        description: "org B's private repo",
        active: true,
        fetchedAt: new Date(),
      });
      const projBound = await makeProject(
        orgA,
        'pk-bound-repo',
        'A product with no repos of its own',
      );
      const ctx = baseCtx({ orgId: orgA, boundProjectId: projBound });
      const result = await ASSIST_TOOLS_BY_NAME.project_knowledge.handler(ctx, {
        projectId: projBound,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.repos).toHaveLength(0);
    });
  });

  describe('my_prior_takes', () => {
    it("never returns another organization's prior writing - org scoping", async () => {
      const orgA = await ensureOrg('pt-org-a');
      const orgB = await ensureOrg('pt-org-b');
      const linkedin = await platformId('linkedin');
      await recordVoiceSamples(getDb(), orgA, linkedin, [
        { externalId: 'pt-a-1', text: 'We just finished a big database migration this week.' },
      ]);
      await recordVoiceSamples(getDb(), orgB, linkedin, [
        {
          externalId: 'pt-b-1',
          text: "Org B's own database migration story, never seen by org A.",
        },
      ]);
      const ctx = baseCtx({ orgId: orgA, boundProjectId: 1 });
      const result = await ASSIST_TOOLS_BY_NAME.my_prior_takes.handler(ctx, {
        query: 'database migration',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.matches).toHaveLength(1);
      expect(result.data.matches[0].excerpt).toContain('We just finished');
    });

    it('refuses with an explicit nothing when nothing matches', async () => {
      const orgA = await ensureOrg('pt-org-empty');
      const ctx = baseCtx({ orgId: orgA, boundProjectId: 1 });
      const result = await ASSIST_TOOLS_BY_NAME.my_prior_takes.handler(ctx, {
        query: 'quantum photosynthesis',
      });
      expect(result.ok).toBe(false);
    });

    it('refuses with an explicit nothing when the query has no searchable words', async () => {
      const orgA = await ensureOrg('pt-org-nowords');
      const ctx = baseCtx({ orgId: orgA, boundProjectId: 1 });
      const result = await ASSIST_TOOLS_BY_NAME.my_prior_takes.handler(ctx, { query: 'a an it' });
      expect(result.ok).toBe(false);
    });
  });

  describe('check_style', () => {
    it('never refuses - a clean draft gets an empty findings list', async () => {
      const ctx = baseCtx({ orgId: 1, boundProjectId: 1 });
      const result = await ASSIST_TOOLS_BY_NAME.check_style.handler(ctx, {
        text: 'A clean, direct sentence.',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.findings).toEqual([]);
    });

    it('surfaces a real house-style finding', async () => {
      const ctx = baseCtx({ orgId: 1, boundProjectId: 1 });
      const result = await ASSIST_TOOLS_BY_NAME.check_style.handler(ctx, {
        text: 'This is great \u2014 really great.',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.findings.length).toBeGreaterThan(0);
    });
  });

  describe('the tool set', () => {
    it('declares exactly the seven tools the design doc names', () => {
      expect(ASSIST_TOOLS.map((t) => t.name).sort()).toEqual([
        'author_history',
        'check_style',
        'look_at_image',
        'my_prior_takes',
        'operator_voice',
        'project_knowledge',
        'read_thread',
      ]);
    });
  });
});
