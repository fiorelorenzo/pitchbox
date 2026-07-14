import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { resolveOrgId, requireOrgId, requireRole } from '$lib/server/auth.js';
import { listProjects, createProjectTx, ProjectSlugConflictError } from '@pitchbox/shared/projects';

const slugRegex = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const CreateBody = z.object({
  slug: z.string().regex(slugRegex, 'lowercase, digits, hyphens; 1-64 chars').optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  defaultAgentRunner: z.string().min(1).default('claude-code'),
  account: z
    .object({
      handle: z.string().min(1).max(64),
      role: z.enum(['personal', 'brand']),
      platformSlug: z.string().min(1),
    })
    .optional(),
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export async function GET(event) {
  const orgId = await resolveOrgId(event);
  const rows = await listProjects(getDb(), { organizationId: orgId });
  return json({ projects: rows });
}

export async function POST(event) {
  const { request } = event;
  const raw = await request.json().catch(() => null);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const db = getDb();

  const slug = body.slug ?? slugify(body.name);
  if (!slugRegex.test(slug)) {
    return json({ error: 'invalid_slug', slug }, { status: 400 });
  }

  let accountArg: { handle: string; role: 'personal' | 'brand'; platformId: number } | undefined;
  if (body.account) {
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, body.account.platformSlug));
    if (!platform) {
      return json({ error: 'unknown_platform', slug: body.account.platformSlug }, { status: 400 });
    }
    accountArg = {
      handle: body.account.handle,
      role: body.account.role,
      platformId: platform.id,
    };
  }

  const organizationId = await requireOrgId(event);
  requireRole(event, 'admin');

  try {
    const out = await createProjectTx(db, {
      slug,
      name: body.name,
      description: body.description,
      defaultAgentRunner: body.defaultAgentRunner,
      account: accountArg,
      organizationId,
    });
    return json({ id: out.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ProjectSlugConflictError) {
      return json({ error: 'slug_conflict', slug }, { status: 409 });
    }
    throw error(500, (e as Error).message);
  }
}
