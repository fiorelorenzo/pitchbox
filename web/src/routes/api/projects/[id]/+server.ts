import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import {
  getProjectById,
  updateProject,
  deleteProject,
  ProjectDeleteSlugMismatchError,
} from '@pitchbox/shared/projects';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { isRunnerAllowed } from '@pitchbox/shared/edition';
import { ASSIST_TONES, ASSIST_TONE_NOTES_MAX } from '@pitchbox/shared/linkedin-assist';

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  defaultAgentRunner: z.string().min(1).optional(),
  // Per-project voice override (#408). `null` clears it back to "inherit the
  // org tone" - see resolveEffectiveVoice in linkedin-assist.ts. An unknown
  // value is rejected rather than coerced, the same as the org-level tone
  // save: the project page is the one writer, so anything else is a stale
  // tab or a hand-built request.
  voiceTone: z.enum(ASSIST_TONES).nullable().optional(),
  voiceToneNotes: z.string().max(ASSIST_TONE_NOTES_MAX).nullable().optional(),
});

const DeleteBody = z.object({ confirmSlug: z.string().min(1) });

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(event: RequestEvent) {
  const { params } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const db = getDb();
  const project = await getProjectById(db, id);
  if (!project) return json({ error: 'not_found' }, { status: 404 });
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.projectId, id));
  return json({ project, accounts });
}

export async function PATCH(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  requireRole(event, 'admin');
  const raw = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const db = getDb();
  const project = await getProjectById(db, id);
  if (!project) return json({ error: 'not_found' }, { status: 404 });
  if (
    parsed.data.defaultAgentRunner !== undefined &&
    !isRunnerAllowed(parsed.data.defaultAgentRunner)
  ) {
    return json(
      {
        error: 'runner_not_allowed',
        message: `Agent runner "${parsed.data.defaultAgentRunner}" is not available in this deployment's edition.`,
      },
      { status: 400 },
    );
  }
  // Mirrors the org-level save (api/settings/linkedin-assist): the free-text
  // tone is the only option whose instruction is the operator's own words,
  // so choosing it here without writing any would silently override the org
  // tone with an empty instruction rather than the words the operator meant.
  if (parsed.data.voiceTone === 'custom' && !parsed.data.voiceToneNotes?.trim()) {
    return json(
      {
        error: 'invalid_body',
        message: 'describe the tone you want, or pick "Use organization default"',
      },
      { status: 400 },
    );
  }
  await updateProject(db, id, parsed.data);
  return json({ ok: true });
}

export async function DELETE(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  requireRole(event, 'admin');
  const raw = await request.json().catch(() => null);
  const parsed = DeleteBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body' }, { status: 400 });
  }
  try {
    await deleteProject(getDb(), id, parsed.data.confirmSlug);
  } catch (e) {
    if (e instanceof ProjectDeleteSlugMismatchError) {
      return json({ error: 'slug_mismatch' }, { status: 400 });
    }
    throw e;
  }
  return json({ ok: true });
}
