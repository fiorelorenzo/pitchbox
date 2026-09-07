import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import {
  load,
  actions,
  type CompanionPersona,
  type CompanionVoiceSample,
} from '../src/routes/settings/companion/+page.server.js';

// Settings -> Companion (2026-09-07 companion decisions): the loader and its
// two form actions are org-structural config in the same class as LinkedIn
// assist (docs/permissions.md), so this defends the same two things
// linkedin-assist-settings.test.ts defends for that page: the admin role
// gate, and that one organization's persona/voice never crosses into
// another's.

// `load` is typed against the generated `PageServerLoad` (see $types) and
// each action against the generated `Actions` - mirrors layout-orgs.test.ts's
// `Parameters<typeof load>[0]` approach so a mock event only needs to satisfy
// what the route actually reads (`locals`, `request`) rather than the full
// SvelteKit event shape.
type LoadEvent = Parameters<typeof load>[0];
type ActionEvent = Parameters<typeof actions.saveProfile>[0];
type LoadResult = {
  profile: CompanionPersona | null;
  voiceSamples: CompanionVoiceSample[];
  maxVoiceSamples: number;
};

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE operator_voice_samples, operator_profiles, projects, memberships, users RESTART IDENTITY CASCADE`,
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

function loadEv(orgId: number, role: string): LoadEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
    url: new URL('http://x/settings/companion'),
    request: new Request('http://x/settings/companion'),
  } as unknown as LoadEvent;
}

function actionEv(orgId: number, role: string, form: FormData): ActionEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
    request: new Request('http://x/settings/companion', { method: 'POST', body: form }),
  } as unknown as ActionEvent;
}

async function statusOf(fn: () => unknown): Promise<number | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

describe('settings/companion load', () => {
  beforeEach(reset);

  it('a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-member');
    expect(await statusOf(() => load(loadEv(orgId, 'member')))).toBe(403);
  });

  it('an admin with nothing captured yet gets a null profile and no samples', async () => {
    const orgId = await seedOrg('comp-admin-empty');
    const result = (await load(loadEv(orgId, 'admin'))) as LoadResult;
    expect(result.profile).toBeNull();
    expect(result.voiceSamples).toEqual([]);
    expect(result.maxVoiceSamples).toBe(4);
  });

  it('never crosses an organization boundary', async () => {
    const orgA = await seedOrg('comp-a');
    const orgB = await seedOrg('comp-b');
    const platformId = await linkedinPlatformId();
    await getDb()
      .insert(schema.operatorProfiles)
      .values({ organizationId: orgA, handle: 'a-handle', displayName: 'Org A' });
    await getDb()
      .insert(schema.operatorVoiceSamples)
      .values({ organizationId: orgA, externalId: 'post-a', platformId, text: 'org a voice' });

    const resultB = (await load(loadEv(orgB, 'admin'))) as LoadResult;
    expect(resultB.profile).toBeNull();
    expect(resultB.voiceSamples).toEqual([]);

    const resultA = (await load(loadEv(orgA, 'admin'))) as LoadResult;
    expect(resultA.profile?.handle).toBe('a-handle');
    expect(resultA.voiceSamples).toHaveLength(1);
  });
});

describe('settings/companion actions', () => {
  beforeEach(reset);

  it('saveProfile: a member is forbidden (403)', async () => {
    const orgId = await seedOrg('comp-save-member');
    const form = new FormData();
    form.set('displayName', 'Jane');
    expect(await statusOf(() => actions.saveProfile(actionEv(orgId, 'member', form)))).toBe(403);
  });

  it('saveProfile: a manual edit is saved with source manual and readable back through load', async () => {
    const orgId = await seedOrg('comp-save-admin');
    const form = new FormData();
    form.set('displayName', 'Jane Doe');
    form.set('headline', 'Building things');
    form.set('experiences', JSON.stringify([{ title: 'Engineer', company: 'Acme' }]));
    const saved = (await actions.saveProfile(actionEv(orgId, 'admin', form))) as {
      profile: CompanionPersona;
    };
    expect(saved.profile.displayName).toBe('Jane Doe');
    expect(saved.profile.source).toBe('manual');
    expect(saved.profile.experiences).toEqual([{ title: 'Engineer', company: 'Acme' }]);

    const reloaded = (await load(loadEv(orgId, 'admin'))) as LoadResult;
    expect(reloaded.profile?.displayName).toBe('Jane Doe');
    expect(reloaded.profile?.source).toBe('manual');
  });

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
    expect(await statusOf(() => actions.toggleVoiceSample(actionEv(orgId, 'member', form)))).toBe(
      403,
    );
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
    await actions.toggleVoiceSample(actionEv(orgB, 'admin', form));

    const [untouched] = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.id, sample.id));
    expect(untouched.excluded).toBe(false);

    // The rightful org can toggle it.
    await actions.toggleVoiceSample(actionEv(orgA, 'admin', form));
    const [toggled] = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.id, sample.id));
    expect(toggled.excluded).toBe(true);
  });
});

afterAll(async () => {
  await getPool().end();
});
