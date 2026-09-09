import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { resolveOrgId, requireOrgId, requireRole } from '$lib/server/auth.js';
import { listProjects, createProjectTx, ProjectSlugConflictError } from '@pitchbox/shared/projects';
import { resolveDefaultRunnerSlug } from '@pitchbox/shared/agents/config';
import { isRunnerAllowed } from '@pitchbox/shared/edition';
import { billingPeriodFor } from '@pitchbox/shared/org-quota';
import { getOrgUsage } from '@pitchbox/shared/usage';
import { checkUsageThresholds } from '@pitchbox/shared/usage-notifications';
import { isOrgReadOnly } from '@pitchbox/shared/plans';

const slugRegex = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const CreateBody = z.object({
  slug: z.string().regex(slugRegex, 'lowercase, digits, hyphens; 1-64 chars').optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  // Omitted = whatever this deployment can actually launch (#219), resolved
  // server-side: Settings' default runner, else the edition default.
  defaultAgentRunner: z.string().min(1).optional(),
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

  // An explicit runner in the request bypasses `resolveDefaultRunnerSlug`
  // (the resolver every other caller goes through, which is edition-aware
  // already) - the create form never sends this itself, but a direct API
  // call still can, and that call is a new write like any other (#410).
  if (body.defaultAgentRunner !== undefined && !isRunnerAllowed(body.defaultAgentRunner)) {
    return json(
      {
        error: 'runner_not_allowed',
        message: `Agent runner "${body.defaultAgentRunner}" is not available in this deployment's edition.`,
      },
      { status: 400 },
    );
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

  // #548: a project is a structural, non-period-bound axis - the count is
  // "how many exist right now", so `period` only matters for the
  // period-bound axes this same snapshot also carries.
  const period = await billingPeriodFor(db, organizationId);
  const usage = await getOrgUsage(db, organizationId, period);
  // #557: a courtesy notification never blocks project creation, admitted
  // or refused by the checks below.
  try {
    await checkUsageThresholds(db, organizationId, usage, period);
  } catch (err) {
    console.error('[projects] checkUsageThresholds failed:', err);
  }
  // #554: a failed payment past its grace window refuses before the plan's
  // own project limit below.
  if (isOrgReadOnly(usage.entitlements)) {
    return json({ error: 'plan_payment_required' }, { status: 402 });
  }
  if (usage.projects.limit != null && usage.projects.used >= usage.projects.limit) {
    return json(
      {
        error: 'plan_limit_reached',
        metric: 'projects',
        limit: usage.projects.limit,
        used: usage.projects.used,
      },
      { status: 402 },
    );
  }
  try {
    const out = await createProjectTx(db, {
      slug,
      name: body.name,
      description: body.description,
      defaultAgentRunner: body.defaultAgentRunner ?? (await resolveDefaultRunnerSlug(db)),
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
