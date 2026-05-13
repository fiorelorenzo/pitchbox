import { eq, sql } from 'drizzle-orm';
import type { getDb } from '../db/client.js';
import { schema } from '../db/client.js';

type Db = ReturnType<typeof getDb>;

export class ProjectSlugConflictError extends Error {
  constructor(public slug: string) {
    super(`Project slug already exists: ${slug}`);
  }
}

export class ProjectDeleteSlugMismatchError extends Error {
  constructor() {
    super('Confirm slug does not match project slug');
  }
}

export type ProjectListRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  defaultAgentRunner: string;
  createdAt: Date;
  updatedAt: Date;
  campaignCount: number;
  accountCount: number;
};

export async function listProjects(
  db: Db,
  opts: { organizationId?: number | null } = {},
): Promise<ProjectListRow[]> {
  // Single query - LEFT JOIN both children, GROUP BY the project. Faster than
  // the previous per-row correlated subqueries once the project count grows.
  const orgFilter =
    opts.organizationId != null ? sql`WHERE p.organization_id = ${opts.organizationId}` : sql``;
  const result = await db.execute<{
    id: number;
    slug: string;
    name: string;
    description: string | null;
    default_agent_runner: string;
    created_at: Date | string;
    updated_at: Date | string;
    campaign_count: number;
    account_count: number;
  }>(sql`
    SELECT
      p.id, p.slug, p.name, p.description, p.default_agent_runner,
      p.created_at, p.updated_at,
      COALESCE(COUNT(DISTINCT c.id), 0)::int AS campaign_count,
      COALESCE(COUNT(DISTINCT a.id), 0)::int AS account_count
    FROM projects p
    LEFT JOIN campaigns c ON c.project_id = p.id
    LEFT JOIN accounts  a ON a.project_id = p.id
    ${orgFilter}
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `);
  const list =
    (result as unknown as { rows?: unknown[] }).rows ??
    (Array.isArray(result) ? (result as unknown[]) : []);
  return (
    list as Array<{
      id: number;
      slug: string;
      name: string;
      description: string | null;
      default_agent_runner: string;
      created_at: Date | string;
      updated_at: Date | string;
      campaign_count: number;
      account_count: number;
    }>
  ).map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    defaultAgentRunner: r.default_agent_runner,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    campaignCount: r.campaign_count,
    accountCount: r.account_count,
  }));
}

export async function getProjectById(db: Db, id: number) {
  const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  return row ?? null;
}

export type CreateProjectArgs = {
  slug: string;
  name: string;
  description?: string | null;
  defaultAgentRunner?: string;
  organizationId?: number | null;
  account?: { handle: string; role: 'personal' | 'brand'; platformId: number };
};

export async function createProjectTx(db: Db, args: CreateProjectArgs): Promise<{ id: number }> {
  return await db.transaction(async (tx) => {
    let project: { id: number } | undefined;
    // Resolve org: explicit > the only existing org (single-tenant self-host) > null.
    let organizationId: number | null = args.organizationId ?? null;
    if (organizationId == null) {
      const [row] = await tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, 'default'))
        .limit(1);
      organizationId = row?.id ?? null;
    }
    try {
      [project] = await tx
        .insert(schema.projects)
        .values({
          slug: args.slug,
          name: args.name,
          description: args.description ?? null,
          defaultAgentRunner: args.defaultAgentRunner ?? 'claude-code',
          organizationId,
        })
        .returning({ id: schema.projects.id });
    } catch (e) {
      const err = e as Error & {
        code?: string;
        cause?: Error & { code?: string; constraint?: string };
      };
      const msg = String(err.message ?? '');
      const causeMsg = String(err.cause?.message ?? '');
      const code = err.code ?? err.cause?.code;
      const constraint = err.cause?.constraint ?? '';
      if (
        code === '23505' ||
        constraint.includes('projects_slug') ||
        msg.includes('projects_slug_unique') ||
        msg.includes('duplicate key') ||
        causeMsg.includes('projects_slug_unique') ||
        causeMsg.includes('duplicate key')
      ) {
        throw new ProjectSlugConflictError(args.slug);
      }
      throw e;
    }
    if (!project) throw new Error('Project insert returned no row');

    if (args.account) {
      await tx.insert(schema.accounts).values({
        projectId: project.id,
        platformId: args.account.platformId,
        handle: args.account.handle,
        role: args.account.role,
      });
    }

    return { id: project.id };
  });
}

export async function updateProject(
  db: Db,
  id: number,
  patch: { name?: string; description?: string | null; defaultAgentRunner?: string },
): Promise<void> {
  await db
    .update(schema.projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.projects.id, id));
}

export async function deleteProject(db: Db, id: number, confirmSlug: string): Promise<void> {
  const project = await getProjectById(db, id);
  if (!project) return;
  if (project.slug !== confirmSlug) throw new ProjectDeleteSlugMismatchError();
  await db.delete(schema.projects).where(eq(schema.projects.id, id));
}
