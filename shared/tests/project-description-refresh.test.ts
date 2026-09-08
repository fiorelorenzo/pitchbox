// Exercises shared/src/project-description-refresh.ts: re-deriving a
// project's description when its sources change (#434), without ever
// applying anything until an explicit accept. Covers the pure appendix
// derivation (deterministic, no DB), the on-demand proposal computation
// (mentions an added source, omits a removed one, stays suppressed after a
// decline until something actually changes), and that accept/decline only
// ever act on the *current* proposal, never a stale one the caller might be
// holding.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import {
  createProjectSource,
  deleteProjectSource,
  type ProjectSourceRow,
} from '../src/project-sources.js';
import {
  acceptDescriptionProposal,
  computeDescriptionProposal,
  declineDescriptionProposal,
  deriveProjectDescription,
  describeSourceForAppendix,
  DESCRIPTION_SOURCES_MARKER,
} from '../src/project-description-refresh.js';

const createdOrgIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
});

async function setupOrgAndProject(description: string | null = 'A tool for doing the thing.') {
  const db = getDb();
  const slug = `desc-refresh-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P', description })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

// ---- deriveProjectDescription (pure) ---------------------------------------
/** Builds a full `ProjectSourceRow` fixture, filling in every column
 * `deriveProjectDescription`/`describeSourceForAppendix` do not read with a
 * fixed default, so a test only has to spell out what it actually cares
 * about. */
function fakeSource(overrides: {
  id: number;
  kind: string;
  config: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  active?: boolean;
}): ProjectSourceRow {
  return {
    id: overrides.id,
    projectId: 0,
    kind: overrides.kind,
    config: overrides.config,
    output: overrides.output ?? null,
    active: overrides.active ?? true,
    fetchedAt: null,
    fetchError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('deriveProjectDescription', () => {
  it('returns the base description unchanged when there are no appendix-eligible sources', () => {
    expect(deriveProjectDescription('A tool for doing the thing.', [])).toBe(
      'A tool for doing the thing.',
    );
  });

  it('never mentions a folder/git/upload source - those are extraction inputs, not appendix sources', () => {
    const sources = [
      fakeSource({ id: 1, kind: 'folder', config: { value: '/tmp/a' } }),
      fakeSource({ id: 2, kind: 'git', config: { value: 'https://github.com/x/y' } }),
    ];
    expect(deriveProjectDescription('Base text.', sources)).toBe('Base text.');
  });

  it('appends a marker and a bullet mentioning an added website source', () => {
    const sources = [
      fakeSource({ id: 5, kind: 'website', config: { url: 'https://example.com' } }),
    ];
    const result = deriveProjectDescription('Base text.', sources);
    expect(result).toContain('Base text.');
    expect(result).toContain(DESCRIPTION_SOURCES_MARKER);
    expect(result).toContain('https://example.com');
  });

  it('is idempotent: re-deriving from its own output with the same sources changes nothing', () => {
    const sources = [
      fakeSource({ id: 5, kind: 'website', config: { url: 'https://example.com' } }),
    ];
    const once = deriveProjectDescription('Base text.', sources);
    const twice = deriveProjectDescription(once, sources);
    expect(twice).toBe(once);
  });

  it('drops the appendix and its marker entirely once the last appendix source is removed', () => {
    const sources = [
      fakeSource({ id: 5, kind: 'website', config: { url: 'https://example.com' } }),
    ];
    const withSource = deriveProjectDescription('Base text.', sources);
    const withoutSource = deriveProjectDescription(withSource, []);
    expect(withoutSource).toBe('Base text.');
    expect(withoutSource).not.toContain(DESCRIPTION_SOURCES_MARKER);
  });

  it('keeps hand-written text before the marker untouched across re-derivation', () => {
    const sources = [
      fakeSource({ id: 5, kind: 'website', config: { url: 'https://example.com' } }),
    ];
    const withOne = deriveProjectDescription('Hand-written prose the operator typed.', sources);
    const withTwo = deriveProjectDescription(withOne, [
      ...sources,
      fakeSource({
        id: 6,
        kind: 'github',
        config: { owner: 'acme', repo: 'widget', url: 'https://github.com/acme/widget' },
      }),
    ]);
    expect(withTwo).toContain('Hand-written prose the operator typed.');
    expect(withTwo.split(DESCRIPTION_SOURCES_MARKER)[0]!.trimEnd()).toBe(
      'Hand-written prose the operator typed.',
    );
  });
});

describe('describeSourceForAppendix', () => {
  it('names a GitHub repo with its cached description when available', () => {
    const label = describeSourceForAppendix(
      fakeSource({
        id: 1,
        kind: 'github',
        config: { owner: 'acme', repo: 'widget', url: 'https://github.com/acme/widget' },
        output: { description: 'A tool that does the thing' },
      }),
    );
    expect(label).toContain('acme/widget');
    expect(label).toContain('A tool that does the thing');
  });

  it('falls back to the configured URL for a source with no cached output yet', () => {
    const label = describeSourceForAppendix(
      fakeSource({ id: 1, kind: 'website', config: { url: 'https://example.com' } }),
    );
    expect(label).toContain('https://example.com');
  });
});

// ---- computeDescriptionProposal / accept / decline (DB-backed) -------------

describe('computeDescriptionProposal', () => {
  it('proposes nothing when the description already matches the active source set', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    expect(await computeDescriptionProposal(db, orgId, projectId)).toBeNull();
  });

  it('adding a source proposes a description that mentions it', async () => {
    const { orgId, projectId } = await setupOrgAndProject('A tool for doing the thing.');
    const db = getDb();
    await createProjectSource(db, orgId, projectId, 'website', { url: 'https://example.com' });

    const proposal = await computeDescriptionProposal(db, orgId, projectId);
    expect(proposal).not.toBeNull();
    expect(proposal!.proposedDescription).toContain('A tool for doing the thing.');
    expect(proposal!.proposedDescription).toContain('https://example.com');
    expect(proposal!.previousDescription).toBe('A tool for doing the thing.');
  });

  it('declining keeps the old description, and the same proposal is not shown again', async () => {
    const { orgId, projectId } = await setupOrgAndProject('Base.');
    const db = getDb();
    await createProjectSource(db, orgId, projectId, 'website', { url: 'https://example.com' });
    const proposal = await computeDescriptionProposal(db, orgId, projectId);
    expect(proposal).not.toBeNull();

    const decision = await declineDescriptionProposal(
      db,
      orgId,
      projectId,
      proposal!.proposedDescription,
    );
    expect(decision).toEqual({ ok: true });

    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    expect(project!.description).toBe('Base.'); // untouched

    expect(await computeDescriptionProposal(db, orgId, projectId)).toBeNull(); // suppressed
  });

  it('a further source change un-suppresses a new proposal after a decline', async () => {
    const { orgId, projectId } = await setupOrgAndProject('Base.');
    const db = getDb();
    await createProjectSource(db, orgId, projectId, 'website', { url: 'https://example.com' });
    const first = await computeDescriptionProposal(db, orgId, projectId);
    await declineDescriptionProposal(db, orgId, projectId, first!.proposedDescription);
    expect(await computeDescriptionProposal(db, orgId, projectId)).toBeNull();

    await createProjectSource(db, orgId, projectId, 'github', {
      owner: 'acme',
      repo: 'widget',
      url: 'https://github.com/acme/widget',
    });
    const second = await computeDescriptionProposal(db, orgId, projectId);
    expect(second).not.toBeNull();
    expect(second!.proposedDescription).not.toBe(first!.proposedDescription);
    expect(second!.proposedDescription).toContain('acme/widget');
  });

  it('removing a source proposes a description without it', async () => {
    const { orgId, projectId } = await setupOrgAndProject('Base.');
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'website', {
      url: 'https://example.com',
    });
    const addProposal = await computeDescriptionProposal(db, orgId, projectId);
    await acceptDescriptionProposal(db, orgId, projectId, addProposal!.proposedDescription);

    await deleteProjectSource(db, orgId, created!.id);
    const removeProposal = await computeDescriptionProposal(db, orgId, projectId);
    expect(removeProposal).not.toBeNull();
    expect(removeProposal!.proposedDescription).not.toContain('https://example.com');
    expect(removeProposal!.proposedDescription).toBe('Base.'); // last source gone, appendix drops entirely
  });

  it('returns null for a project in a different organization', async () => {
    const { projectId } = await setupOrgAndProject('Base.');
    const { orgId: otherOrgId } = await setupOrgAndProject('Other.');
    const db = getDb();
    expect(await computeDescriptionProposal(db, otherOrgId, projectId)).toBeNull();
  });
});

describe('acceptDescriptionProposal', () => {
  it('applies the proposed text and records which sources it came from', async () => {
    const { orgId, projectId } = await setupOrgAndProject('Base.');
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'website', {
      url: 'https://example.com',
    });
    const proposal = await computeDescriptionProposal(db, orgId, projectId);

    const result = await acceptDescriptionProposal(
      db,
      orgId,
      projectId,
      proposal!.proposedDescription,
    );
    expect(result).toEqual({ ok: true });

    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    expect(project!.description).toBe(proposal!.proposedDescription);

    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.projectId, projectId));
    expect(run!.kind).toBe('project_description_refresh');
    const params = run!.params as { decision: string; sourceIds: number[] };
    expect(params.decision).toBe('accepted');
    expect(params.sourceIds).toEqual([created!.id]);
  });

  it('rejects a stale proposal instead of applying text that no longer matches the live source set', async () => {
    const { orgId, projectId } = await setupOrgAndProject('Base.');
    const db = getDb();
    const staleText = 'Base.\n\nsomething that was proposed a while ago';

    const result = await acceptDescriptionProposal(db, orgId, projectId, staleText);
    expect(result).toEqual({ ok: false, code: 'stale' });

    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    expect(project!.description).toBe('Base.'); // never applied
  });

  it('refuses a confirmation whose text is not the live proposal, so a hand edit in between survives', async () => {
    // The case that matters for "a hand edit is never overwritten without a
    // confirmation": the operator confirms what their screen showed, and by
    // then the project has moved on. The other stale test above passes for a
    // weaker reason - a project with no sources has no proposal at all - so
    // this one gives the check something live to disagree with.
    const { orgId, projectId } = await setupOrgAndProject('Base.');
    const db = getDb();
    await createProjectSource(db, orgId, projectId, 'website', { url: 'https://example.com' });
    const shown = await computeDescriptionProposal(db, orgId, projectId);
    expect(shown).not.toBeNull();

    // The human edits the description in another tab while the proposal is on
    // screen. Their text is what must survive.
    const handEdited = 'Base, rewritten by me while the dialog was open.';
    await db
      .update(schema.projects)
      .set({ description: handEdited })
      .where(eq(schema.projects.id, projectId));

    const result = await acceptDescriptionProposal(
      db,
      orgId,
      projectId,
      shown!.proposedDescription,
    );
    expect(result).toEqual({ ok: false, code: 'stale' });

    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    expect(project!.description).toBe(handEdited);
  });

  it('returns not_found for a project in a different organization', async () => {
    const { projectId } = await setupOrgAndProject('Base.');
    const { orgId: otherOrgId } = await setupOrgAndProject('Other.');
    const db = getDb();
    expect(await acceptDescriptionProposal(db, otherOrgId, projectId, 'anything')).toEqual({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('declineDescriptionProposal', () => {
  it('rejects a stale proposal rather than recording a decision against text nobody is looking at', async () => {
    const { orgId, projectId } = await setupOrgAndProject('Base.');
    const db = getDb();
    const result = await declineDescriptionProposal(db, orgId, projectId, 'something stale');
    expect(result).toEqual({ ok: false, code: 'stale' });
  });
});
