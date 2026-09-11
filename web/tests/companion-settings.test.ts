import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import {
  load as loadPersona,
  actions as personaActions,
  type CompanionPersona,
} from '../src/routes/companion/+page.server.js';
import {
  load as loadVoice,
  actions as voiceActions,
  type CompanionVoiceSample,
  type CompanionVoiceProfile,
} from '../src/routes/companion/voice/+page.server.js';
import { load as loadWork } from '../src/routes/companion/work/+page.server.js';

// Companion (LOR-178/LOR-179, docs/design/DECISIONS.md D35): the old
// three-card settings/companion page split into three routes -
// companion (persona), companion/voice, companion/work - each gating
// itself in its own +page.server.ts rather than inheriting one from a
// layout. This defends the same two things linkedin-assist-settings.test.ts
// defends for its page, now once per route: the admin role gate, and that
// one organization's persona/voice never crosses into another's. The
// retired settings/companion redirect and the GitHub install round trip's
// new destination are covered by settings-general-redirect.test.ts and
// github-install-flow.test.ts respectively - both routes this file used to
// own before the split.

type PersonaLoadEvent = Parameters<typeof loadPersona>[0];
type PersonaActionEvent = Parameters<typeof personaActions.saveProfile>[0];
type VoiceLoadEvent = Parameters<typeof loadVoice>[0];
type VoiceActionEvent = Parameters<typeof voiceActions.toggleVoiceSample>[0];
type WorkLoadEvent = Parameters<typeof loadWork>[0];

type PersonaLoadResult = { profile: CompanionPersona | null };
type VoiceLoadResult = {
  voiceSamples: CompanionVoiceSample[];
  voiceProfile: CompanionVoiceProfile | null;
};

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE operator_voice_samples, operator_profiles, operator_voice_profiles, projects,
      memberships, users RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedOrg(slug: string): Promise<number> {
  const [org] = await getDb().insert(schema.organizations).values({ slug, name: slug }).returning();
  return org.id;
}

async function linkedinPlatformId(): Promise<number> {
  const [row] = await getDb()
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  return row.id;
}

// `load` is typed against each route's generated `PageServerLoad` (see
// $types) and each action against its generated `Actions` - mirrors
// layout-orgs.test.ts's `Parameters<typeof load>[0]` approach so a mock
// event only needs to satisfy what the route actually reads (`locals`,
// `request`) rather than the full SvelteKit event shape.
function loadEvent<T>(orgId: number, role: string, path: string): T {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
    url: new URL(`http://x${path}`),
    request: new Request(`http://x${path}`),
  } as unknown as T;
}

function actionEvent<T>(orgId: number, role: string, path: string, form: FormData): T {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
    request: new Request(`http://x${path}`, { method: 'POST', body: form }),
  } as unknown as T;
}

async function statusOf(fn: () => unknown): Promise<number | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

describe('companion (persona) load', () => {
  beforeEach(reset);

  it('a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-member');
    expect(
      await statusOf(() => loadPersona(loadEvent<PersonaLoadEvent>(orgId, 'member', '/companion'))),
    ).toBe(403);
  });

  it('an admin with nothing captured yet gets a null profile', async () => {
    const orgId = await seedOrg('comp-admin-empty');
    const result = (await loadPersona(
      loadEvent<PersonaLoadEvent>(orgId, 'admin', '/companion'),
    )) as PersonaLoadResult;
    expect(result.profile).toBeNull();
  });

  it('never crosses an organization boundary', async () => {
    const orgA = await seedOrg('comp-a');
    const orgB = await seedOrg('comp-b');
    await getDb()
      .insert(schema.operatorProfiles)
      .values({ organizationId: orgA, handle: 'a-handle', displayName: 'Org A' });

    const resultB = (await loadPersona(
      loadEvent<PersonaLoadEvent>(orgB, 'admin', '/companion'),
    )) as PersonaLoadResult;
    expect(resultB.profile).toBeNull();

    const resultA = (await loadPersona(
      loadEvent<PersonaLoadEvent>(orgA, 'admin', '/companion'),
    )) as PersonaLoadResult;
    expect(resultA.profile?.handle).toBe('a-handle');
  });
});

describe('companion (persona) actions', () => {
  beforeEach(reset);

  it('saveProfile: a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-save-member');
    const form = new FormData();
    form.set('displayName', 'Jane');
    expect(
      await statusOf(() =>
        personaActions.saveProfile(
          actionEvent<PersonaActionEvent>(orgId, 'member', '/companion', form),
        ),
      ),
    ).toBe(403);
  });

  it('saveProfile: a manual edit is saved with source manual and readable back through load', async () => {
    const orgId = await seedOrg('comp-save-admin');
    const form = new FormData();
    form.set('displayName', 'Jane Doe');
    form.set('headline', 'Building things');
    form.set('experiences', JSON.stringify([{ title: 'Engineer', company: 'Acme' }]));
    const saved = (await personaActions.saveProfile(
      actionEvent<PersonaActionEvent>(orgId, 'admin', '/companion', form),
    )) as { profile: CompanionPersona };
    expect(saved.profile.displayName).toBe('Jane Doe');
    expect(saved.profile.source).toBe('manual');
    expect(saved.profile.experiences).toEqual([{ title: 'Engineer', company: 'Acme' }]);

    const reloaded = (await loadPersona(
      loadEvent<PersonaLoadEvent>(orgId, 'admin', '/companion'),
    )) as PersonaLoadResult;
    expect(reloaded.profile?.displayName).toBe('Jane Doe');
    expect(reloaded.profile?.source).toBe('manual');
  });
});

describe('companion/voice load', () => {
  beforeEach(reset);

  it('a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-voice-member');
    expect(
      await statusOf(() =>
        loadVoice(loadEvent<VoiceLoadEvent>(orgId, 'member', '/companion/voice')),
      ),
    ).toBe(403);
  });

  it('an admin with nothing captured yet gets no samples and no voice profile', async () => {
    const orgId = await seedOrg('comp-voice-empty');
    const result = (await loadVoice(
      loadEvent<VoiceLoadEvent>(orgId, 'admin', '/companion/voice'),
    )) as VoiceLoadResult;
    expect(result.voiceSamples).toEqual([]);
    expect(result.voiceProfile).toBeNull();
  });

  it('never crosses an organization boundary', async () => {
    const orgA = await seedOrg('comp-voice-a');
    const orgB = await seedOrg('comp-voice-b');
    const platformId = await linkedinPlatformId();
    await getDb()
      .insert(schema.operatorVoiceSamples)
      .values({ organizationId: orgA, externalId: 'post-a', platformId, text: 'org a voice' });
    await getDb()
      .insert(schema.operatorVoiceProfiles)
      .values({ organizationId: orgA, summary: 'Org A derived voice.' });

    const resultB = (await loadVoice(
      loadEvent<VoiceLoadEvent>(orgB, 'admin', '/companion/voice'),
    )) as VoiceLoadResult;
    expect(resultB.voiceSamples).toEqual([]);
    expect(resultB.voiceProfile).toBeNull();

    const resultA = (await loadVoice(
      loadEvent<VoiceLoadEvent>(orgA, 'admin', '/companion/voice'),
    )) as VoiceLoadResult;
    expect(resultA.voiceSamples).toHaveLength(1);
    expect(resultA.voiceProfile?.summary).toBe('Org A derived voice.');
  });
});

describe('companion/voice actions', () => {
  beforeEach(reset);

  it('toggleVoiceSample: a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-toggle-member');
    const platformId = await linkedinPlatformId();
    const [sample] = await getDb()
      .insert(schema.operatorVoiceSamples)
      .values({ organizationId: orgId, externalId: 'post-m', platformId, text: 'sample' })
      .returning();
    const form = new FormData();
    form.set('sampleId', String(sample.id));
    form.set('excluded', 'true');
    expect(
      await statusOf(() =>
        voiceActions.toggleVoiceSample(
          actionEvent<VoiceActionEvent>(orgId, 'member', '/companion/voice', form),
        ),
      ),
    ).toBe(403);
  });

  it('toggleVoiceSample: cannot exclude a sample belonging to a different organization', async () => {
    const orgA = await seedOrg('comp-toggle-a');
    const orgB = await seedOrg('comp-toggle-b');
    const platformId = await linkedinPlatformId();
    const [sample] = await getDb()
      .insert(schema.operatorVoiceSamples)
      .values({ organizationId: orgA, externalId: 'post-x', platformId, text: 'org a sample' })
      .returning();

    const form = new FormData();
    form.set('sampleId', String(sample.id));
    form.set('excluded', 'true');
    await voiceActions.toggleVoiceSample(
      actionEvent<VoiceActionEvent>(orgB, 'admin', '/companion/voice', form),
    );

    const [untouched] = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.id, sample.id));
    expect(untouched.excluded).toBe(false);

    // The rightful org can toggle it.
    await voiceActions.toggleVoiceSample(
      actionEvent<VoiceActionEvent>(orgA, 'admin', '/companion/voice', form),
    );
    const [toggled] = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.id, sample.id));
    expect(toggled.excluded).toBe(true);
  });

  it('refreshVoiceProfile: a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-refresh-member');
    expect(
      await statusOf(() =>
        voiceActions.refreshVoiceProfile(
          actionEvent<VoiceActionEvent>(orgId, 'member', '/companion/voice', new FormData()),
        ),
      ),
    ).toBe(403);
  });

  it("refreshVoiceProfile: derives from an org's own voice samples, readable back through load, and excluding one changes it", async () => {
    const orgId = await seedOrg('comp-refresh-admin');
    const platformId = await linkedinPlatformId();
    const samples = await getDb()
      .insert(schema.operatorVoiceSamples)
      .values([
        {
          organizationId: orgId,
          externalId: 'r-1',
          platformId,
          text: 'Just launched the new pricing page today, the whole team is thrilled with it.',
        },
        {
          organizationId: orgId,
          externalId: 'r-2',
          platformId,
          text: 'Just launched a fix for the onboarding flow, our team worked hard this week.',
        },
        {
          organizationId: orgId,
          externalId: 'r-3',
          platformId,
          text: 'Working through customer interviews all week, learned a lot from the team lately.',
        },
      ])
      .returning();

    const before = (await voiceActions.refreshVoiceProfile(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', new FormData()),
    )) as { voiceProfile: CompanionVoiceProfile };
    expect(before.voiceProfile.source).toBe('derived');
    expect(before.voiceProfile.summary).toContain('Just launched');

    const reloaded = (await loadVoice(
      loadEvent<VoiceLoadEvent>(orgId, 'admin', '/companion/voice'),
    )) as VoiceLoadResult;
    expect(reloaded.voiceProfile?.summary).toBe(before.voiceProfile.summary);

    // Exclude both samples that carried "Just launched" - the acceptance
    // case, driven through the real route action rather than a helper.
    const toggleForm1 = new FormData();
    toggleForm1.set('sampleId', String(samples[0].id));
    toggleForm1.set('excluded', 'true');
    await voiceActions.toggleVoiceSample(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', toggleForm1),
    );
    const toggleForm2 = new FormData();
    toggleForm2.set('sampleId', String(samples[1].id));
    toggleForm2.set('excluded', 'true');
    const after = (await voiceActions.toggleVoiceSample(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', toggleForm2),
    )) as { voiceProfile: CompanionVoiceProfile };
    expect(after.voiceProfile.summary).not.toContain('Just launched');
  });

  it('saveVoiceProfile: a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-save-vp-member');
    const form = new FormData();
    form.set('summary', 'Dry and direct.');
    expect(
      await statusOf(() =>
        voiceActions.saveVoiceProfile(
          actionEvent<VoiceActionEvent>(orgId, 'member', '/companion/voice', form),
        ),
      ),
    ).toBe(403);
  });

  it('saveVoiceProfile marks the row manual, and a later refresh leaves it untouched until resetVoiceProfile is called', async () => {
    const orgId = await seedOrg('comp-save-vp-admin');
    const form = new FormData();
    form.set('summary', 'Dry, first person, one idea per post.');
    const saved = (await voiceActions.saveVoiceProfile(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', form),
    )) as { voiceProfile: CompanionVoiceProfile };
    expect(saved.voiceProfile.source).toBe('manual');
    expect(saved.voiceProfile.summary).toBe('Dry, first person, one idea per post.');

    const refreshed = (await voiceActions.refreshVoiceProfile(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', new FormData()),
    )) as { voiceProfile: CompanionVoiceProfile };
    expect(refreshed.voiceProfile.source).toBe('manual');
    expect(refreshed.voiceProfile.summary).toBe('Dry, first person, one idea per post.');

    const wasReset = (await voiceActions.resetVoiceProfile(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', new FormData()),
    )) as { voiceProfile: CompanionVoiceProfile };
    expect(wasReset.voiceProfile.source).toBe('derived');
  });

  it('resetVoiceProfile: a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-reset-vp-member');
    expect(
      await statusOf(() =>
        voiceActions.resetVoiceProfile(
          actionEvent<VoiceActionEvent>(orgId, 'member', '/companion/voice', new FormData()),
        ),
      ),
    ).toBe(403);
  });

  // FIXTURE NOTE: byte-identical to `cli/tests/commands/voice-import.test.ts`'s
  // `SHARES_CSV` - kept in sync by hand since CLI and web are separate
  // workspaces. Both suites assert their result against
  // `parseSharesCsv`/`parseCommentsCsv` directly (the same functions
  // `voiceImportRun` and this route's `importVoice` action both call
  // under the hood), which is what actually proves the two paths cannot
  // drift, rather than a literal string comparison across processes.
  const IMPORT_SHARES_CSV = [
    'Date,ShareLink,ShareCommentary',
    '2026-03-01,https://www.linkedin.com/feed/update/urn:li:activity:cli-1,Shipped the new export importer today.',
    '2026-03-02,https://www.linkedin.com/feed/update/urn:li:activity:cli-2,',
    '2026-03-03,https://www.linkedin.com/feed/update/urn:li:activity:cli-3,Wrapped up a long week of onboarding fixes.',
  ].join('\n');

  function csvFile(text: string, name: string): File {
    return new File([text], name, { type: 'text/csv' });
  }

  it('importVoice: a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-import-member');
    const form = new FormData();
    form.set('file', csvFile(IMPORT_SHARES_CSV, 'Shares.csv'));
    expect(
      await statusOf(() =>
        voiceActions.importVoice(
          actionEvent<VoiceActionEvent>(orgId, 'member', '/companion/voice', form),
        ),
      ),
    ).toBe(403);
  });

  it('importVoice: refuses to run without a file, with a readable message rather than a stack trace', async () => {
    const orgId = await seedOrg('comp-import-nofile');
    const result = (await voiceActions.importVoice(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', new FormData()),
    )) as { status: number; data: { importError: string } };
    expect(result.status).toBe(400);
    expect(result.data.importError).toMatch(/choose a linkedin export/i);
  });

  it('importVoice: refuses a file whose header matches neither known export shape', async () => {
    const orgId = await seedOrg('comp-import-badheader');
    const form = new FormData();
    form.set('file', csvFile('Foo,Bar\n1,2', 'export.csv'));
    const result = (await voiceActions.importVoice(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', form),
    )) as { status: number; data: { importError: string } };
    expect(result.status).toBe(400);
    expect(result.data.importError).toBeTruthy();
  });

  it('importVoice: parses Shares.csv the same way the CLI does, dedups on re-upload, and re-derives the voice profile', async () => {
    const orgId = await seedOrg('comp-import-shares');
    const { parseSharesCsv } = await import('@pitchbox/shared/voice-import');
    const expected = parseSharesCsv(IMPORT_SHARES_CSV);

    const form = new FormData();
    form.set('file', csvFile(IMPORT_SHARES_CSV, 'Shares.csv'));
    const first = (await voiceActions.importVoice(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', form),
    )) as { imported: { inserted: number; byGenre: { post: number; comment: number } } };
    expect(first.imported.inserted).toBe(expected.length);
    expect(first.imported.byGenre).toEqual({ post: expected.length, comment: 0 });

    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, orgId));
    expect(rows.map((r) => r.text).sort()).toEqual(expected.map((i) => i.text).sort());
    expect(rows.every((r) => r.genre === 'post' && r.source === 'import')).toBe(true);

    const [profile] = await getDb()
      .select()
      .from(schema.operatorVoiceProfiles)
      .where(eq(schema.operatorVoiceProfiles.organizationId, orgId));
    expect(profile.source).toBe('derived');

    // Re-uploading the same export is a no-op, the same dedup the CLI relies on.
    const secondForm = new FormData();
    secondForm.set('file', csvFile(IMPORT_SHARES_CSV, 'Shares.csv'));
    const second = (await voiceActions.importVoice(
      actionEvent<VoiceActionEvent>(orgId, 'admin', '/companion/voice', secondForm),
    )) as { imported: { inserted: number } };
    expect(second.imported.inserted).toBe(0);
  });
});

describe('companion/work load', () => {
  beforeEach(reset);

  // No data to gate here (the repo list and the GitHub App panel are both
  // client-fetched from their own already-gated endpoints), but the route
  // still repeats the admin gate on its own - this is what proves it does.
  it('a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-work-member');
    expect(
      await statusOf(() => loadWork(loadEvent<WorkLoadEvent>(orgId, 'member', '/companion/work'))),
    ).toBe(403);
  });

  it('an admin is served', async () => {
    const orgId = await seedOrg('comp-work-admin');
    await expect(
      loadWork(loadEvent<WorkLoadEvent>(orgId, 'admin', '/companion/work')),
    ).resolves.toEqual({});
  });
});

afterAll(async () => {
  await getPool().end();
});
