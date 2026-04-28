import { eq, sql } from 'drizzle-orm';
import type { getDb } from '../db/client.js';
import { schema } from '../db/client.js';
import { parseConfigValue } from './config-schemas.js';

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

export async function listProjects(db: Db): Promise<ProjectListRow[]> {
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
      COALESCE((SELECT COUNT(*) FROM campaigns c WHERE c.project_id = p.id), 0)::int AS campaign_count,
      COALESCE((SELECT COUNT(*) FROM accounts a WHERE a.project_id = p.id), 0)::int AS account_count
    FROM projects p
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
  configs: { key: string; value: unknown }[];
  account: { handle: string; role: 'personal' | 'brand'; platformId: number };
};

export async function createProjectTx(db: Db, args: CreateProjectArgs): Promise<{ id: number }> {
  // Pre-validate config values BEFORE opening the tx.
  const configs = args.configs.map((c) => ({
    key: c.key,
    value: parseConfigValue(c.key, c.value),
  }));

  return await db.transaction(async (tx) => {
    let project: { id: number } | undefined;
    try {
      [project] = await tx
        .insert(schema.projects)
        .values({
          slug: args.slug,
          name: args.name,
          description: args.description ?? null,
          defaultAgentRunner: args.defaultAgentRunner ?? 'claude-code',
        })
        .returning({ id: schema.projects.id });
    } catch (e) {
      const err = e as Error & { code?: string; cause?: Error & { code?: string; constraint?: string } };
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

    if (configs.length > 0) {
      await tx.insert(schema.projectConfigs).values(
        configs.map((c) => ({
          projectId: project!.id,
          key: c.key,
          value: c.value,
          version: 1,
        })),
      );
    }

    await tx.insert(schema.accounts).values({
      projectId: project.id,
      platformId: args.account.platformId,
      handle: args.account.handle,
      role: args.account.role,
    });

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
