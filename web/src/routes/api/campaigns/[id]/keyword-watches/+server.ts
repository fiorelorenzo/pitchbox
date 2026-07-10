import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { campaignBelongsToOrg } from '@pitchbox/shared/orgs';

const PostBody = z.object({
  subreddit: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_]+$/, 'invalid subreddit'),
  pattern: z.string().min(1).max(500),
  matchField: z.enum(['title', 'selftext', 'comment']).default('title'),
  isActive: z.boolean().optional(),
  cooldownMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
});

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(event: RequestEvent) {
  const { params } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });

  const orgId = await requireOrgId(event);
  if (!(await campaignBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.keywordWatches)
    .where(eq(schema.keywordWatches.campaignId, id))
    .orderBy(desc(schema.keywordWatches.createdAt));
  return json({ watches: rows });
}

export async function POST(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });

  const orgId = await requireOrgId(event);
  if (!(await campaignBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');

  const raw = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const db = getDb();
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
  if (!campaign) return json({ error: 'not_found' }, { status: 404 });

  const [row] = await db
    .insert(schema.keywordWatches)
    .values({
      projectId: campaign.projectId,
      campaignId: id,
      subreddit: parsed.data.subreddit,
      pattern: parsed.data.pattern,
      matchField: parsed.data.matchField,
      isActive: parsed.data.isActive ?? true,
      cooldownMinutes: parsed.data.cooldownMinutes ?? 30,
    })
    .returning();
  return json({ watch: row }, { status: 201 });
}

const PatchBody = z.object({
  watchId: z.number().int().positive(),
  isActive: z.boolean().optional(),
  pattern: z.string().min(1).max(500).optional(),
  matchField: z.enum(['title', 'selftext', 'comment']).optional(),
  cooldownMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
});

export async function PATCH(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });

  const orgId = await requireOrgId(event);
  if (!(await campaignBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');

  const raw = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const { watchId, ...rest } = parsed.data;
  const db = getDb();
  const [row] = await db
    .update(schema.keywordWatches)
    .set(rest)
    .where(and(eq(schema.keywordWatches.id, watchId), eq(schema.keywordWatches.campaignId, id)))
    .returning();
  if (!row) return json({ error: 'not_found' }, { status: 404 });
  return json({ watch: row });
}

export async function DELETE(event: RequestEvent) {
  const { params, url } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });

  const orgId = await requireOrgId(event);
  if (!(await campaignBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');

  const watchId = Number(url.searchParams.get('watchId'));
  if (!Number.isInteger(watchId) || watchId <= 0) {
    return json({ error: 'invalid_watch_id' }, { status: 400 });
  }
  const db = getDb();
  const [row] = await db
    .delete(schema.keywordWatches)
    .where(and(eq(schema.keywordWatches.id, watchId), eq(schema.keywordWatches.campaignId, id)))
    .returning();
  if (!row) return json({ error: 'not_found' }, { status: 404 });
  return json({ ok: true });
}
