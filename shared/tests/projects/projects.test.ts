import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '../../src/db/client.js';
import {
  listProjects,
  getProjectById,
  createProjectTx,
  updateProject,
  deleteProject,
  ProjectSlugConflictError,
  ProjectDeleteSlugMismatchError,
} from '../../src/projects/projects.js';

async function platformId(slug: string) {
  const [p] = await getDb().select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

describe('projects helpers', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE projects RESTART IDENTITY CASCADE`);
  });

  it('createProjectTx inserts project + account atomically', async () => {
    const pid = await platformId('reddit');
    const out = await createProjectTx(getDb(), {
      slug: 'demo',
      name: 'Demo',
      description: 'd',
      defaultAgentRunner: 'claude-code',
      account: { handle: 'me', role: 'personal', platformId: pid },
    });
    expect(out.id).toBeGreaterThan(0);
    const list = await listProjects(getDb());
    expect(list.map((p) => p.slug)).toEqual(['demo']);
    expect(list[0].accountCount).toBe(1);
    expect(list[0].campaignCount).toBe(0);
  });

  it('createProjectTx without account creates project only', async () => {
    const out = await createProjectTx(getDb(), { slug: 'no-acc', name: 'No account' });
    const list = await listProjects(getDb());
    expect(list.map((p) => p.slug)).toEqual(['no-acc']);
    expect(list[0].accountCount).toBe(0);
    expect(out.id).toBeGreaterThan(0);
  });

  it('createProjectTx rejects duplicate slug', async () => {
    const pid = await platformId('reddit');
    const args = {
      slug: 'dup',
      name: 'A',
      account: { handle: 'h', role: 'personal' as const, platformId: pid },
    };
    await createProjectTx(getDb(), args);
    await expect(createProjectTx(getDb(), args)).rejects.toBeInstanceOf(ProjectSlugConflictError);
  });

  it('updateProject changes name/description', async () => {
    const pid = await platformId('reddit');
    const { id } = await createProjectTx(getDb(), {
      slug: 'upd',
      name: 'A',
      account: { handle: 'h', role: 'personal', platformId: pid },
    });
    await updateProject(getDb(), id, { name: 'B', description: 'desc' });
    const p = await getProjectById(getDb(), id);
    expect(p?.name).toBe('B');
    expect(p?.description).toBe('desc');
  });

  // #408: a fresh project has no voice override (both columns null,
  // resolveEffectiveVoice's "inherit" case), updateProject can set one, and
  // setting voiceTone back to null clears it rather than leaving a stale
  // voiceToneNotes value orphaned behind it.
  it('updateProject round-trips a voice override and can clear it back to null', async () => {
    const pid = await platformId('reddit');
    const { id } = await createProjectTx(getDb(), {
      slug: 'voice-upd',
      name: 'A',
      account: { handle: 'h', role: 'personal', platformId: pid },
    });
    const fresh = await getProjectById(getDb(), id);
    expect(fresh?.voiceTone).toBeNull();
    expect(fresh?.voiceToneNotes).toBeNull();

    await updateProject(getDb(), id, { voiceTone: 'custom', voiceToneNotes: 'Dry, no hype.' });
    const withOverride = await getProjectById(getDb(), id);
    expect(withOverride?.voiceTone).toBe('custom');
    expect(withOverride?.voiceToneNotes).toBe('Dry, no hype.');

    await updateProject(getDb(), id, { voiceTone: null, voiceToneNotes: null });
    const cleared = await getProjectById(getDb(), id);
    expect(cleared?.voiceTone).toBeNull();
    expect(cleared?.voiceToneNotes).toBeNull();
  });

  it('deleteProject with matching slug cascades children', async () => {
    const pid = await platformId('reddit');
    const { id } = await createProjectTx(getDb(), {
      slug: 'delme',
      name: 'd',
      account: { handle: 'h', role: 'personal', platformId: pid },
    });
    await deleteProject(getDb(), id, 'delme');
    expect(await getProjectById(getDb(), id)).toBeNull();
    const acc = await getDb()
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.projectId, id));
    expect(acc).toEqual([]);
  });

  it('deleteProject rejects mismatched slug', async () => {
    const pid = await platformId('reddit');
    const { id } = await createProjectTx(getDb(), {
      slug: 'safe',
      name: 's',
      account: { handle: 'h', role: 'personal', platformId: pid },
    });
    await expect(deleteProject(getDb(), id, 'wrong')).rejects.toBeInstanceOf(
      ProjectDeleteSlugMismatchError,
    );
    expect(await getProjectById(getDb(), id)).not.toBeNull();
  });
});
