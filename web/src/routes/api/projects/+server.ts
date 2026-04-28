import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import {
  listProjects,
  createProjectTx,
  ProjectSlugConflictError,
} from '@pitchbox/shared/projects';

const slugRegex = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const CreateBody = z.object({
  slug: z.string().regex(slugRegex, 'lowercase, digits, hyphens; 1-64 chars'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  defaultAgentRunner: z.string().min(1).default('claude-code'),
  configs: z
    .array(z.object({ key: z.string().min(1), value: z.unknown() }))
    .default([]),
  account: z.object({
    handle: z.string().min(1).max(64),
    role: z.enum(['personal', 'brand']),
    platformSlug: z.string().min(1),
  }),
});

export async function GET() {
  const rows = await listProjects(getDb());
  return json({ projects: rows });
}

export async function POST({ request }) {
  const raw = await request.json().catch(() => null);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const db = getDb();

  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, body.account.platformSlug));
  if (!platform) {
    return json({ error: 'unknown_platform', slug: body.account.platformSlug }, { status: 400 });
  }

  try {
    const out = await createProjectTx(db, {
      slug: body.slug,
      name: body.name,
      description: body.description,
      defaultAgentRunner: body.defaultAgentRunner,
      configs: body.configs.map((c) => ({ key: c.key, value: c.value })),
      account: {
        handle: body.account.handle,
        role: body.account.role,
        platformId: platform.id,
      },
    });
    return json({ id: out.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ProjectSlugConflictError) {
      return json({ error: 'slug_conflict', slug: body.slug }, { status: 409 });
    }
    if (e instanceof z.ZodError) {
      return json({ error: 'invalid_config', issues: e.issues }, { status: 400 });
    }
    throw error(500, (e as Error).message);
  }
}
