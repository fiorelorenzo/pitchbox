import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { QUOTA_DEFAULTS } from './db/seed-core.js';
import { projectBelongsToOrg } from './orgs.js';

// The org-level off switch and owner for the in-page LinkedIn assistant
// (LI-19, #316, docs/linkedin-integration-design.md). Until this exists the
// collector (#302) and the panel (#314) have no legitimate way to know
// whether they should be running or which project they write as.
//
// Stored in app_config the same way quota_defaults is (shared/src/quota.ts):
// one row, keyed by a sub-entity inside the jsonb blob. quota_defaults keys
// by platform slug because it is instance-wide; this keys by organization id
// because assist is a per-org setting (bound project, per-org caps).

const CONFIG_KEY = 'linkedin_assist';

/**
 * Hard ceilings a daily cap may never exceed, matching the LinkedIn quota
 * defaults (docs/linkedin-integration-design.md, "Quota and blocklist"): an
 * account that comments forty times a day is indistinguishable from a bot to
 * LinkedIn's velocity monitoring, so the product does not offer that knob.
 * These track QUOTA_DEFAULTS.linkedin rather than duplicating the numbers.
 */
export const ASSIST_COMMENT_CAP_CEILING = QUOTA_DEFAULTS.linkedin.comment.perDay;
export const ASSIST_POST_CAP_CEILING = QUOTA_DEFAULTS.linkedin.post.perDay;

export type LinkedInAssistSettings = {
  /** Whether the in-page assistant may be used at all. Off by default: a fresh install must not start collecting. */
  enabled: boolean;
  /** The project a suggestion is written as. A suggestion has to be written as some project's voice, so `enabled` cannot be saved true without one. */
  projectId: number | null;
  /** Whether the passive observation collector runs. Independent of `enabled` so an operator can gather observations without yet exposing suggestions, or vice versa. */
  collectorEnabled: boolean;
  /** Comments/day, clamped to ASSIST_COMMENT_CAP_CEILING. */
  dailyCommentCap: number;
  /** Posts/day, clamped to ASSIST_POST_CAP_CEILING. */
  dailyPostCap: number;
  /**
   * Emergency stop, separate from `enabled`. Flipping this must be visible on
   * the extension's very next poll (docs/linkedin-integration-design.md: "a
   * kill switch that takes ten minutes to apply is not a kill switch") - there
   * is no cache between this flag and the read path, so that is automatic.
   */
  killSwitch: boolean;
};

export function defaultLinkedInAssistSettings(): LinkedInAssistSettings {
  return {
    enabled: false,
    projectId: null,
    collectorEnabled: false,
    dailyCommentCap: ASSIST_COMMENT_CAP_CEILING,
    dailyPostCap: ASSIST_POST_CAP_CEILING,
    killSwitch: false,
  };
}

type StoredBlob = Record<string, Partial<LinkedInAssistSettings>>;

export async function loadLinkedInAssistSettings(
  db: Db,
  organizationId: number,
): Promise<LinkedInAssistSettings> {
  const [row] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, CONFIG_KEY))
    .limit(1);
  const blob = (row?.value ?? {}) as StoredBlob;
  const stored = blob[String(organizationId)];
  return { ...defaultLinkedInAssistSettings(), ...stored };
}

export async function saveLinkedInAssistSettings(
  db: Db,
  organizationId: number,
  settings: LinkedInAssistSettings,
): Promise<void> {
  const [row] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, CONFIG_KEY))
    .limit(1);
  const blob = (row?.value ?? {}) as StoredBlob;
  const next: StoredBlob = { ...blob, [String(organizationId)]: settings };
  await db
    .insert(schema.appConfig)
    .values({ key: CONFIG_KEY, value: next })
    .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: next } });
}

/** The exact shape served to the extension by GET /api/extension/linkedin-assist. */
export type LinkedInAssistDeviceState = {
  /** Effective, not raw: false whenever the bound project no longer exists, or `killSwitch` is set, even if the stored flag is true. */
  enabled: boolean;
  /** Effective: also requires `enabled` and a live bound project. */
  collectorEnabled: boolean;
  /** Raw flag, exposed separately so a consumer can render "stopped by an admin" distinctly from "never turned on". */
  killSwitch: boolean;
  /** Null when unbound or when the stored project id no longer resolves in this org. */
  projectId: number | null;
  dailyCommentCap: number;
  dailyPostCap: number;
};

/**
 * Collapses stored settings into the effective state a device should act on.
 * Re-validates the bound project against the org on every read (jsonb holds
 * no foreign key) so a deleted project can't leave a stale "enabled: true,
 * projectId: <gone>" reading after the fact.
 */
export async function loadLinkedInAssistDeviceState(
  db: Db,
  organizationId: number,
): Promise<LinkedInAssistDeviceState> {
  const settings = await loadLinkedInAssistSettings(db, organizationId);
  const projectId =
    settings.projectId != null &&
    (await projectBelongsToOrg(db, settings.projectId, organizationId))
      ? settings.projectId
      : null;
  const boundAndLive = settings.enabled && projectId != null && !settings.killSwitch;
  return {
    enabled: boundAndLive,
    collectorEnabled: boundAndLive && settings.collectorEnabled,
    killSwitch: settings.killSwitch,
    projectId,
    dailyCommentCap: settings.dailyCommentCap,
    dailyPostCap: settings.dailyPostCap,
  };
}
