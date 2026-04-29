import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../db/client.js';
import { schema } from '../db/client.js';
import { parseConfigValue } from './config-schemas.js';

type Db = ReturnType<typeof getDb>;

export class ConfigConflictError extends Error {
  constructor(
    public projectId: number,
    public key: string,
    public latestVersion: number,
  ) {
    super(`Config "${key}" was updated elsewhere (latest version: ${latestVersion})`);
  }
}

export type ConfigRow = {
  key: string;
  value: unknown;
  version: number;
  createdAt: Date;
};

export async function listLatestConfigs(db: Db, projectId: number): Promise<ConfigRow[]> {
  const result = await db.execute<{
    key: string;
    value: unknown;
    version: number;
    created_at: Date;
  }>(sql`
    SELECT DISTINCT ON (key) key, value, version, created_at
    FROM project_configs
    WHERE project_id = ${projectId}
    ORDER BY key, version DESC
  `);
  // node-postgres returns { rows }; pg.Pool drivers via drizzle wrap differently — be defensive.
  const list =
    (result as unknown as { rows?: unknown[] }).rows ??
    (Array.isArray(result) ? (result as unknown[]) : []);
  return (
    list as Array<{ key: string; value: unknown; version: number; created_at: Date | string }>
  ).map((r) => ({
    key: r.key,
    value: r.value,
    version: r.version,
    createdAt: new Date(r.created_at),
  }));
}

export async function getLatestConfig(
  db: Db,
  projectId: number,
  key: string,
): Promise<ConfigRow | null> {
  const [row] = await db
    .select()
    .from(schema.projectConfigs)
    .where(and(eq(schema.projectConfigs.projectId, projectId), eq(schema.projectConfigs.key, key)))
    .orderBy(desc(schema.projectConfigs.version))
    .limit(1);
  if (!row) return null;
  return {
    key: row.key,
    value: row.value,
    version: row.version,
    createdAt: row.createdAt,
  };
}

export async function saveConfigVersion(
  db: Db,
  projectId: number,
  key: string,
  rawValue: unknown,
  expectedPreviousVersion: number | null,
): Promise<{ version: number }> {
  const value = parseConfigValue(key, rawValue);
  const latest = await getLatestConfig(db, projectId, key);
  const latestVersion = latest?.version ?? null;
  // Optimistic concurrency:
  // - If caller expected `null` (creating), latest must be null.
  // - If caller expected N, latest must equal N.
  if (expectedPreviousVersion !== latestVersion) {
    throw new ConfigConflictError(projectId, key, latestVersion ?? 0);
  }
  const nextVersion = (latestVersion ?? 0) + 1;
  await db.insert(schema.projectConfigs).values({ projectId, key, value, version: nextVersion });
  return { version: nextVersion };
}

export async function deleteConfigKey(db: Db, projectId: number, key: string): Promise<void> {
  await db
    .delete(schema.projectConfigs)
    .where(and(eq(schema.projectConfigs.projectId, projectId), eq(schema.projectConfigs.key, key)));
}
