import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { getSchema } from '@pitchbox/shared/campaigns';

const Patch = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['active', 'paused']).optional(),
  cronExpression: z.string().nullable().optional(),
  agentRunner: z.string().min(1).optional(),
  config: z.unknown().optional(),
});

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH({ params, request }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const raw = await request.json().catch(() => null);
  const parsed = Patch.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, id));
  if (!campaign) return json({ error: 'not_found' }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  if (parsed.data.cronExpression !== undefined) patch.cronExpression = parsed.data.cronExpression;
  if (parsed.data.agentRunner !== undefined) patch.agentRunner = parsed.data.agentRunner;

  if (parsed.data.config !== undefined) {
    const scenarioSchema = getSchema(
      campaign.skillSlug as 'reddit-scout' | 'reddit-commenter',
    );
    const result = scenarioSchema.safeParse(parsed.data.config);
    if (!result.success) {
      return json(
        { error: 'invalid_config', issues: result.error.issues },
        { status: 400 },
      );
    }
    patch.config = result.data;
  }

  if (parsed.data.status === 'active') {
    const cfg =
      patch.config !== undefined
        ? (patch.config as Record<string, unknown>)
        : (campaign.config as Record<string, unknown>);
    if (!cfg || Object.keys(cfg).length === 0) {
      return json({ error: 'cannot_activate_without_config' }, { status: 400 });
    }
  }

  if (Object.keys(patch).length === 0) return json({ ok: true });

  await db.update(schema.campaigns).set(patch).where(eq(schema.campaigns.id, id));
  return json({ ok: true });
}
