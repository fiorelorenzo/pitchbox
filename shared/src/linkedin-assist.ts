import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { QUOTA_DEFAULTS } from './db/seed-core.js';
import { projectBelongsToOrg } from './orgs.js';
import { ensurePersonalProject } from './personal-project.js';

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

// The tone vocabulary lives in `assist/tone.ts`, a leaf module, so the prompt
// builder can have it without importing this file and with it the db client
// (see that module's own note). Re-exported here because this is where an
// operator-facing setting is expected to be found.
export {
  ASSIST_TONES,
  ASSIST_TONE_NOTES_MAX,
  DEFAULT_ASSIST_TONE,
  isAssistTone,
  type AssistTone,
} from './assist/tone.js';
import { DEFAULT_ASSIST_TONE, isAssistTone, ASSIST_TONE_NOTES_MAX } from './assist/tone.js';
import type { AssistTone } from './assist/tone.js';

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
  /** How a suggestion should sound (#405). Defaults to `match-room`. */
  tone: AssistTone;
  /** The operator's own sentence, used only when `tone` is `custom`. */
  toneNotes: string;
};

export function defaultLinkedInAssistSettings(): LinkedInAssistSettings {
  return {
    enabled: false,
    projectId: null,
    collectorEnabled: false,
    dailyCommentCap: ASSIST_COMMENT_CAP_CEILING,
    dailyPostCap: ASSIST_POST_CAP_CEILING,
    killSwitch: false,
    tone: DEFAULT_ASSIST_TONE,
    toneNotes: '',
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
  const merged = { ...defaultLinkedInAssistSettings(), ...stored };
  // jsonb holds no enum, so a value written by an older build, a hand-edited
  // row or a future option name can arrive here. An unrecognised tone falls
  // back to the default rather than reaching the prompt as a literal - the
  // prompt would otherwise instruct the model in a register nobody chose.
  if (!isAssistTone(merged.tone)) merged.tone = DEFAULT_ASSIST_TONE;
  merged.toneNotes = clampToneNotes(merged.toneNotes);
  return merged;
}

/** Trims a stored tone-notes value to the shared ceiling, and coerces
 * anything that arrived as a non-string (a stale or hand-edited row) to an
 * empty one rather than letting it reach a prompt. Shared by the org
 * settings load above and the project-override resolver below, so the two
 * do not drift on what "clamp" means. */
function clampToneNotes(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, ASSIST_TONE_NOTES_MAX) : '';
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
  /** The org's `personal` project (shared/src/personal-project.ts, decision
   * 2026-09-07), always present: an accepted suggestion has to file
   * somewhere even when nothing is bound, and the panel uses this id for
   * that regardless of what `projectId` names. Created on first read if it
   * somehow does not exist yet, so this never goes stale like `projectId` can. */
  personalProjectId: number;
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
  const [projectLive, personalProjectId] = await Promise.all([
    settings.projectId != null
      ? projectBelongsToOrg(db, settings.projectId, organizationId)
      : Promise.resolve(false),
    ensurePersonalProject(db, organizationId),
  ]);
  const projectId = settings.projectId != null && projectLive ? settings.projectId : null;
  const boundAndLive = settings.enabled && projectId != null && !settings.killSwitch;
  return {
    enabled: boundAndLive,
    collectorEnabled: boundAndLive && settings.collectorEnabled,
    killSwitch: settings.killSwitch,
    projectId,
    personalProjectId,
    dailyCommentCap: settings.dailyCommentCap,
    dailyPostCap: settings.dailyPostCap,
  };
}

/** The tone and notes actually used for a suggestion (#408). */
export type EffectiveVoice = {
  tone: AssistTone;
  toneNotes: string;
};

/**
 * Resolves the voice a suggestion should be written in, given the project it
 * is actually being filed under - not the org's bound project, which the
 * personal-project carve-out (2026-09-07) already lets a request diverge
 * from. Precedence: the project's own override if it set one, else the org's
 * `linkedin_assist` tone, which itself already falls back to
 * `DEFAULT_ASSIST_TONE` when nothing was ever saved (`loadLinkedInAssistSettings`
 * above) - so this is the one place all three levels collapse into a single
 * answer, rather than each caller re-deriving the fallback chain itself.
 *
 * `project` only needs its two voice columns, not a full row, so a caller
 * that already selected the project (the suggest route does, to enforce the
 * binding) can pass it straight through with no second query.
 *
 * An unrecognised `voiceTone` (a column written by an older build, or a
 * value nobody offers anymore) is treated the same as unset - it falls
 * through to the org setting rather than reaching a prompt as a literal,
 * mirroring how `loadLinkedInAssistSettings` treats a stale jsonb tone.
 */
export async function resolveEffectiveVoice(
  db: Db,
  organizationId: number,
  project: { voiceTone: string | null; voiceToneNotes: string | null },
): Promise<EffectiveVoice> {
  if (isAssistTone(project.voiceTone)) {
    return { tone: project.voiceTone, toneNotes: clampToneNotes(project.voiceToneNotes) };
  }
  const settings = await loadLinkedInAssistSettings(db, organizationId);
  return { tone: settings.tone, toneNotes: settings.toneNotes };
}
