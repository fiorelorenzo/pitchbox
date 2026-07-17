import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { appConfig } from '../db/schema.js';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from './meta.js';
import type { PermissionDecision, PermissionRule } from './acp/permission.js';

/**
 * Selects and configures the `PermissionPolicy` an ACP runner uses to answer
 * `session/request_permission`. `auto-allow` (the default when unset) preserves
 * today's behavior of approving everything; `configurable` evaluates `rules` in
 * order (first match wins) and falls back to `defaultDecision` (allow, unless
 * set otherwise) when none match. See `acp/permission.ts` for rule matching.
 */
export type PermissionPolicyConfig = {
  name: 'auto-allow' | 'configurable';
  rules?: PermissionRule[];
  defaultDecision?: PermissionDecision;
};

export type RunnerConfig = {
  model?: string;
  maxTurns?: number;
  extraArgs?: string[];
  permissionPolicy?: PermissionPolicyConfig;
};

export type RunnerConfigsByRunner = Record<AgentRunnerSlug, RunnerConfig>;

const KEY = 'runner_configs';

function empty(): RunnerConfigsByRunner {
  const out = {} as RunnerConfigsByRunner;
  for (const m of AGENT_RUNNER_META) out[m.slug] = {};
  return out;
}

export async function loadRunnerConfigs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
): Promise<RunnerConfigsByRunner> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, KEY));
  if (!row) return empty();
  const stored = (row.value as Partial<RunnerConfigsByRunner>) ?? {};
  return { ...empty(), ...stored };
}

export async function loadRunnerConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  slug: AgentRunnerSlug,
): Promise<RunnerConfig> {
  const all = await loadRunnerConfigs(db);
  return all[slug] ?? {};
}

export async function saveRunnerConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  slug: AgentRunnerSlug,
  cfg: RunnerConfig,
): Promise<void> {
  const all = await loadRunnerConfigs(db);
  all[slug] = cfg;
  await db
    .insert(appConfig)
    .values({ key: KEY, value: all })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: all } });
}
