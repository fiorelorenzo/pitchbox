import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { appConfig } from '../db/schema.js';
import { loadGatewayCatalogue } from './gateway-catalogue.js';

// Which model does which job (#411). Before this, the only knob was
// `runner_configs`, keyed by runner slug and shared by every plane, which is
// why the assist path had to hardcode its own fast default and why an operator
// pinning a model for one purpose pinned it for all of them.
//
// The functions are the jobs the product actually runs, not the playbooks:
// several playbooks draft a message and want the same model, and a job with no
// model call of its own does not get a knob. `quality_judge` (LOR-229) is the
// opposite of the deliberate omission this comment used to describe: judging
// a draft's quality now DOES earn a model call, but only when an admin has
// explicitly configured one here - `shared/src/quality-judge.ts` checks
// `loadModelFunctionConfig` directly (never `resolveFunctionModel`, which
// would fall back to `defaultModelId` below) so an unconfigured deployment
// never dials out on a path metered by draft volume. The deterministic part
// of the score (style findings + the operator's own measured voice profile)
// still needs no model at all.

export const MODEL_FUNCTIONS = [
  'campaign_draft',
  'assist_suggest',
  'assist_vision',
  'project_extract',
  'project_insights',
  'skill_generate',
  'quality_judge',
] as const;

export type ModelFunction = (typeof MODEL_FUNCTIONS)[number];

export interface ModelFunctionMeta {
  fn: ModelFunction;
  label: string;
  /** What the model is doing, in the operator's terms, for the admin form. */
  description: string;
  /**
   * The model this function runs on when nobody configured it. One cheap fast
   * model everywhere on purpose: the expensive default is the one that costs
   * money on every tenant's every run before anyone has measured whether the
   * job needs it. `google/gemini-3.1-flash-lite` is the id sazio runs its own
   * conversation loop on.
   */
  defaultModelId: string;
}

const FAST_DEFAULT = 'google/gemini-3.1-flash-lite';

export const MODEL_FUNCTION_META: readonly ModelFunctionMeta[] = [
  {
    fn: 'campaign_draft',
    label: 'Drafting outreach',
    description:
      'A campaign run reading candidates and writing the drafts a human reviews in the Inbox. Also the model behind a reply draft and a regenerated draft, which are the same job with a narrower input.',
    defaultModelId: FAST_DEFAULT,
  },
  {
    fn: 'assist_suggest',
    label: 'Answering in the panel',
    description:
      'The in-page companion suggesting a comment or a post while somebody waits for it. The only path here with a human watching an empty panel, so first-token latency is the constraint that matters.',
    defaultModelId: FAST_DEFAULT,
  },
  {
    fn: 'assist_vision',
    label: 'Looking at an image in the panel',
    description:
      'The in-page companion reading the pixels of a post\u2019s image, chart or slide before suggesting a comment on it. Skipped entirely on a text-only post, so this only runs when the crop the extension captured is actually present.',
    defaultModelId: FAST_DEFAULT,
  },
  {
    fn: 'project_extract',
    label: 'Describing a project',
    description:
      'Reading a repository, a folder or a website and writing what the project is. Runs rarely and its output is read by every later prompt.',
    defaultModelId: FAST_DEFAULT,
  },
  {
    fn: 'project_insights',
    label: 'Summarising insights',
    description: 'Turning what a project knows into the notes the drafting prompts carry.',
    defaultModelId: FAST_DEFAULT,
  },
  {
    fn: 'skill_generate',
    label: 'Generating a campaign profile',
    description:
      'Writing a campaign profile from a project and a scenario, which then has to validate against that scenario schema.',
    defaultModelId: FAST_DEFAULT,
  },
  {
    fn: 'quality_judge',
    label: 'Judging a draft\u2019s quality',
    description:
      'An optional second opinion on a drafted reply: a real model reads it against the quality rubric and returns its own score, alongside (never instead of) the deterministic score every draft already gets from the style checker and the operator\u2019s own measured voice. Off by default - it only runs once a model is set here, since it is a per-draft cost on a path billed by volume.',
    defaultModelId: FAST_DEFAULT,
  },
];

export function isModelFunction(value: unknown): value is ModelFunction {
  return typeof value === 'string' && (MODEL_FUNCTIONS as readonly string[]).includes(value);
}

/**
 * Which function a playbook slug belongs to. Several playbooks are the same job:
 * every commenter, poster and scout drafts outreach, and so do the reply drafter
 * and the draft regenerator. A slug nobody mapped falls back to `campaign_draft`
 * rather than throwing, because this resolves inside a dispatch that is already
 * running and a new playbook is not a reason to fail the run.
 */
export function modelFunctionForPlaybook(slug: string): ModelFunction {
  if (slug === 'project-extractor') return 'project_extract';
  if (slug === 'project-insighter') return 'project_insights';
  if (slug === 'campaign-skill-generator') return 'skill_generate';
  return 'campaign_draft';
}

const KEY = 'model_functions';

type StoredBlob = Record<string, { modelId?: unknown } | undefined>;

export type ModelFunctionConfig = Record<ModelFunction, string | null>;

function emptyConfig(): ModelFunctionConfig {
  const out = {} as ModelFunctionConfig;
  for (const fn of MODEL_FUNCTIONS) out[fn] = null;
  return out;
}

// A short cache because this is read on every dispatch and every suggestion,
// and the row behind it changes when an admin saves a form. The TTL is the
// backstop for a multi-instance deployment where another process saved it; the
// same-process save invalidates explicitly, so an admin never has to wait to
// see their own change take effect (the acceptance criterion is "no restart",
// not "eventually").
const CACHE_TTL_MS = 30_000;
let cache: { value: ModelFunctionConfig; expiresAt: number } | null = null;

export function clearModelFunctionCache(): void {
  cache = null;
}

export async function loadModelFunctionConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
): Promise<ModelFunctionConfig> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, KEY));
  const stored = (row?.value ?? {}) as StoredBlob;
  const value = emptyConfig();
  for (const fn of MODEL_FUNCTIONS) {
    const raw = stored[fn]?.modelId;
    // jsonb holds no enum, so a hand-edited row or an older build can put
    // anything here. An unusable value reads as unset, which lands on the coded
    // default rather than sending a garbage model id to the Gateway.
    if (typeof raw === 'string' && raw.trim()) value[fn] = raw.trim();
  }
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function saveModelFunctionModel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  fn: ModelFunction,
  modelId: string | null,
): Promise<void> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, KEY));
  const stored = { ...((row?.value ?? {}) as StoredBlob) };
  const trimmed = modelId?.trim();
  if (trimmed) stored[fn] = { modelId: trimmed };
  else delete stored[fn];
  await db
    .insert(appConfig)
    .values({ key: KEY, value: stored })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: stored } });
  clearModelFunctionCache();
}

export function defaultModelForFunction(fn: ModelFunction): string {
  return MODEL_FUNCTION_META.find((m) => m.fn === fn)?.defaultModelId ?? FAST_DEFAULT;
}

/**
 * The model a function runs on: what an admin configured, else the coded
 * default. Never throws and never returns empty, because this is called inside
 * a dispatch that is already running: a run that dies because nobody
 * configured a function is worse than a run on a default.
 */
export async function resolveFunctionModel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  fn: ModelFunction,
): Promise<string> {
  const config = await loadModelFunctionConfig(db);
  return config[fn] ?? defaultModelForFunction(fn);
}

/**
 * Whether a runner slug takes a Gateway model id at all. Only the managed
 * runner does: an ACP backend is a coding-agent CLI whose `model` option is
 * that CLI's own vocabulary (`sonnet`, `opus`), so handing it
 * `google/gemini-3.1-flash-lite` would fail the run on a deployment that never
 * asked for any of this. This is why the resolution below returns undefined
 * rather than a default for those: undefined means "leave today's behaviour
 * alone", which is the operator's `runner_configs` pin if they set one and the
 * CLI's own default if they did not.
 */
export function runnerTakesGatewayModel(slug: string): boolean {
  return slug === 'cloud';
}

/**
 * The model a dispatch should ask for, given the runner it is dispatching to
 * and the playbook it is running. Undefined when the runner does not speak
 * Gateway ids, so a caller can leave its config untouched.
 */
export async function resolveModelForRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  args: { runnerSlug: string; playbookSlug: string },
): Promise<string | undefined> {
  if (!runnerTakesGatewayModel(args.runnerSlug)) return undefined;
  return resolveFunctionModel(db, modelFunctionForPlaybook(args.playbookSlug));
}

/**
 * A model counts as "premium" once the Gateway catalogue prices its output
 * tokens at or above this line (#547). What actually matters is the run
 * cost, not the per-token number: measured on the preview database, the
 * same `campaign` kind costs $0.17 to $0.37 per run on the Claude-class
 * agentic path against $0.0051 on `google/gemini-3.1-flash-lite`
 * (`FAST_DEFAULT` above) - a 30x-plus gap driven entirely by which model
 * ran it. Flash Lite prices output at $0.0000006/token; Claude Sonnet-class
 * models, the cheapest ones actually capable of the agentic path, start at
 * $0.000015/token, 25x higher. $0.000005/token sits between the two with
 * headroom on both sides, so a routine vendor pricing update does not flip
 * the classification.
 */
export const PREMIUM_OUTPUT_PRICE_PER_TOKEN_USD = 0.000005;

/**
 * Classifies a Gateway model id by price rather than by name, so a new
 * Claude/GPT-class model needs no allow-list edit to count as premium. A
 * model the catalogue cannot price - an unknown id, a self-host deployment
 * with no Gateway key, a transient catalogue fetch failure - counts as
 * premium too: the safe direction when the alternative is silently letting
 * an unpriced model through a plan's gate.
 */
export async function isPremiumModel(modelId: string): Promise<boolean> {
  const catalogue = await loadGatewayCatalogue();
  const model = catalogue.models.find((m) => m.id === modelId);
  if (!model || model.outputPerToken == null) return true;
  return model.outputPerToken >= PREMIUM_OUTPUT_PRICE_PER_TOKEN_USD;
}

/**
 * The premium-model gate (#547), applied at every point a model is resolved
 * for a dispatch - never in the admin form, which only hides an option
 * rather than enforcing anything (`shared/src/edition.ts` makes the same
 * argument for runner slugs). `modelId` is whatever the caller already
 * resolved - an admin's `model_functions` pin, an operator's
 * `runner_configs` pin, or the coded default - and an org whose plan does
 * not allow premium models runs on `fn`'s coded default fast model
 * regardless of which of those it was. A plan that does allow premium
 * models never reaches `isPremiumModel`, so a self-host deployment
 * (unlimited on every axis) never pays for a Gateway catalogue fetch it has
 * no key for. This is not a substitute for the org's own USD run budget
 * (`shared/src/org-quota.ts`) - it is what keeps that budget from being hit
 * in three runs.
 */
export async function gateModelForPlan(
  fn: ModelFunction,
  modelId: string,
  allowPremium: boolean,
): Promise<string> {
  if (allowPremium) return modelId;
  return (await isPremiumModel(modelId)) ? defaultModelForFunction(fn) : modelId;
}
