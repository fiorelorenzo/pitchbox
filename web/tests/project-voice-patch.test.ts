import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { getProjectById } from '@pitchbox/shared/projects';
import { PATCH as projectPatch } from '../src/routes/api/projects/[id]/+server.js';

/**
 * #408: the project page writes a voice override through the same PATCH
 * route as name/description/defaultAgentRunner, admin-gated exactly like
 * those (docs/permissions.md). What these tests defend is the two things
 * that route call adds on top of the generic patch: a value nobody offers
 * is rejected (matching the org-level tone save), and `custom` without any
 * notes is rejected the same way the org-level tone save already is.
 */

async function reset() {
  await getDb().execute(sql`TRUNCATE projects RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedOrgProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

function patchEvent(orgId: number, projectId: number, body: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'admin' }, locale: 'en' },
    params: { id: String(projectId) },
    request: new Request('http://x/', { method: 'PATCH', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

describe('PATCH /api/projects/[id] voice override (#408)', () => {
  beforeEach(reset);

  it('accepts a named tone and persists it', async () => {
    const { orgId, projectId } = await seedOrgProject('voice-patch-named');
    const res = await projectPatch(patchEvent(orgId, projectId, { voiceTone: 'warm' }));
    expect(res.status).toBe(200);
    const project = await getProjectById(getDb(), projectId);
    expect(project?.voiceTone).toBe('warm');
  });

  it('clears the override back to null (inherit)', async () => {
    const { orgId, projectId } = await seedOrgProject('voice-patch-clear');
    await projectPatch(patchEvent(orgId, projectId, { voiceTone: 'warm' }));
    const res = await projectPatch(
      patchEvent(orgId, projectId, { voiceTone: null, voiceToneNotes: null }),
    );
    expect(res.status).toBe(200);
    const project = await getProjectById(getDb(), projectId);
    expect(project?.voiceTone).toBeNull();
  });

  it('rejects a tone value nobody offers (400), and nothing is saved', async () => {
    const { orgId, projectId } = await seedOrgProject('voice-patch-unknown');
    const res = await projectPatch(patchEvent(orgId, projectId, { voiceTone: 'sarcastic-pirate' }));
    expect(res.status).toBe(400);
    const project = await getProjectById(getDb(), projectId);
    expect(project?.voiceTone).toBeNull();
  });

  it('rejects "custom" with no notes (400), and nothing is saved', async () => {
    const { orgId, projectId } = await seedOrgProject('voice-patch-custom-empty');
    const res = await projectPatch(
      patchEvent(orgId, projectId, { voiceTone: 'custom', voiceToneNotes: '   ' }),
    );
    expect(res.status).toBe(400);
    const project = await getProjectById(getDb(), projectId);
    expect(project?.voiceTone).toBeNull();
  });

  it('accepts "custom" once real notes are given', async () => {
    const { orgId, projectId } = await seedOrgProject('voice-patch-custom-ok');
    const res = await projectPatch(
      patchEvent(orgId, projectId, { voiceTone: 'custom', voiceToneNotes: 'Dry, no hype.' }),
    );
    expect(res.status).toBe(200);
    const project = await getProjectById(getDb(), projectId);
    expect(project?.voiceTone).toBe('custom');
    expect(project?.voiceToneNotes).toBe('Dry, no hype.');
  });

  it('a member is forbidden (403), and nothing is saved', async () => {
    const { orgId, projectId } = await seedOrgProject('voice-patch-member');
    const event = {
      locals: { org: { id: orgId, slug: 'x', role: 'member' } },
      params: { id: String(projectId) },
      request: new Request('http://x/', {
        method: 'PATCH',
        body: JSON.stringify({ voiceTone: 'warm' }),
      }),
    } as unknown as RequestEvent;
    await expect(projectPatch(event)).rejects.toMatchObject({ status: 403 });
    const project = await getProjectById(getDb(), projectId);
    expect(project?.voiceTone).toBeNull();
  });
});
