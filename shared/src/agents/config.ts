import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { appConfig } from '../db/schema.js';
import { isCloud } from '../edition.js';
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

const DEFAULT_RUNNER_KEY = 'default_runner';

/** The runner an admin picked in Settings, or null when they never did. */
export async function loadDefaultRunnerSlug(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
): Promise<AgentRunnerSlug | null> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, DEFAULT_RUNNER_KEY));
  const stored = row?.value;
  if (!stored || typeof stored !== 'object' || !('slug' in stored)) return null;
  const slug = stored.slug;
  if (typeof slug !== 'string') return null;
  return AGENT_RUNNER_META.some((m) => m.slug === slug && m.implemented)
    ? (slug as AgentRunnerSlug)
    : null;
}

export async function saveDefaultRunnerSlug(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  slug: AgentRunnerSlug,
): Promise<void> {
  const value = { slug };
  await db
    .insert(appConfig)
    .values({ key: DEFAULT_RUNNER_KEY, value })
    .onConflictDoUpdate({ target: appConfig.key, set: { value } });
}

/**
 * The runner slug a new project snapshots when the caller doesn't name one.
 * Settings wins; otherwise the edition decides, because the cloud build ships
 * no local agent CLI - defaulting it to `claude-code` there hands every new
 * project a runner the deployment can never launch (#219).
 */
export async function resolveDefaultRunnerSlug(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
): Promise<AgentRunnerSlug> {
  return (await loadDefaultRunnerSlug(db)) ?? (isCloud() ? 'cloud' : 'claude-code');
}
