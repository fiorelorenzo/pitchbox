import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
  resolveEffectiveVoice,
} from '../src/linkedin-assist.js';

/**
 * #408: a per-project voice override that falls back to the org's
 * `linkedin_assist` tone, and beyond that to `DEFAULT_ASSIST_TONE`. This is
 * the one place that three-level fallback is decided - everything else
 * (the suggest route, the project page) just calls it, so what these tests
 * defend is the precedence itself, not any particular caller.
 */

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE projects RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function ensureOrg(slug: string): Promise<number> {
  const db = getDb();
  await db.insert(schema.organizations).values({ slug, name: slug }).onConflictDoNothing();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug));
  return org.id;
}

async function makeProject(
  organizationId: number,
  slug: string,
  voice: { voiceTone?: string | null; voiceToneNotes?: string | null } = {},
): Promise<number> {
  const db = getDb();
  const [p] = await db
    .insert(schema.projects)
    .values({
      organizationId,
      slug,
      name: slug,
      voiceTone: voice.voiceTone ?? null,
      voiceToneNotes: voice.voiceToneNotes ?? null,
    })
    .returning({ id: schema.projects.id });
  return p.id;
}

describe('resolveEffectiveVoice (#408)', () => {
  beforeEach(reset);

  it('falls back to DEFAULT_ASSIST_TONE when neither the project nor the org set anything', async () => {
    const db = getDb();
    const orgId = await ensureOrg('voice-none');
    const projectId = await makeProject(orgId, 'voice-none-p');
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    const voice = await resolveEffectiveVoice(db, orgId, project);
    expect(voice).toEqual({ tone: 'match-room', toneNotes: '' });
  });

  it('uses the org tone when the project has no override', async () => {
    const db = getDb();
    const orgId = await ensureOrg('voice-org-only');
    await saveLinkedInAssistSettings(db, orgId, {
      ...defaultLinkedInAssistSettings(),
      tone: 'technical',
    });
    const projectId = await makeProject(orgId, 'voice-org-only-p');
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    const voice = await resolveEffectiveVoice(db, orgId, project);
    expect(voice.tone).toBe('technical');
  });

  it("the project's override wins over the org tone", async () => {
    const db = getDb();
    const orgId = await ensureOrg('voice-project-wins');
    await saveLinkedInAssistSettings(db, orgId, {
      ...defaultLinkedInAssistSettings(),
      tone: 'technical',
    });
    const projectId = await makeProject(orgId, 'voice-project-wins-p', { voiceTone: 'warm' });
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    const voice = await resolveEffectiveVoice(db, orgId, project);
    expect(voice.tone).toBe('warm');
  });

  // The default tone itself, explicitly set as an override, must still beat
  // a *different* org tone - proving the resolver checks "is this column
  // null" rather than "does this equal DEFAULT_ASSIST_TONE".
  it('an override explicitly equal to DEFAULT_ASSIST_TONE still beats a different org tone', async () => {
    const db = getDb();
    const orgId = await ensureOrg('voice-explicit-default');
    await saveLinkedInAssistSettings(db, orgId, {
      ...defaultLinkedInAssistSettings(),
      tone: 'technical',
    });
    const projectId = await makeProject(orgId, 'voice-explicit-default-p', {
      voiceTone: 'match-room',
    });
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    const voice = await resolveEffectiveVoice(db, orgId, project);
    expect(voice.tone).toBe('match-room');
  });

  it("carries the project's own notes when the override is custom", async () => {
    const db = getDb();
    const orgId = await ensureOrg('voice-custom-notes');
    await saveLinkedInAssistSettings(db, orgId, {
      ...defaultLinkedInAssistSettings(),
      tone: 'custom',
      toneNotes: 'org-level custom notes nobody should see here',
    });
    const projectId = await makeProject(orgId, 'voice-custom-notes-p', {
      voiceTone: 'custom',
      voiceToneNotes: 'Talk like a lab notebook.',
    });
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    const voice = await resolveEffectiveVoice(db, orgId, project);
    expect(voice).toEqual({ tone: 'custom', toneNotes: 'Talk like a lab notebook.' });
  });

  // A column written by an older build, or a value nobody offers anymore,
  // is not a valid override - it falls through to the org tone exactly like
  // an unset column, rather than reaching a prompt as a literal.
  it('an unrecognised voiceTone value falls through to the org tone', async () => {
    const db = getDb();
    const orgId = await ensureOrg('voice-garbage');
    await saveLinkedInAssistSettings(db, orgId, {
      ...defaultLinkedInAssistSettings(),
      tone: 'plain',
    });
    const projectId = await makeProject(orgId, 'voice-garbage-p', {
      voiceTone: 'sarcastic-pirate',
    });
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    const voice = await resolveEffectiveVoice(db, orgId, project);
    expect(voice.tone).toBe('plain');
  });
});
