// Re-deriving a project's description when its sources change (#434). A
// project's description used to be a single column an extraction run
// overwrote outright (`projectExtractFinish` in cli/src/commands/project.ts);
// now that sources are a set (#431/#433), adding or removing one has to
// update the description too - and the one rule that matters is that a hand
// edit is never thrown away without confirmation.
//
// This never calls a model. `project_extract` (the full extraction) reads a
// whole repository and writes prose about what a project is, which is
// genuinely a writing task and stays a model job. Re-deriving on a source
// add/remove is a narrower, mechanical one - "does the sources appendix
// match the current source set" - and the repo already has a rule for that
// distinction: `shared/src/assist/register.ts` and `operator_voice_profiles`
// (#407) both keep a measurement deterministic rather than spending a model
// call and a test's ability to pin the wording on something with one
// obviously correct answer. This is the same shape: for each active
// "standalone" source (github/website/linkedin_*, never the transient
// folder/git/upload inputs `project_extract` already consumed into the
// description's own prose), one bullet naming it, assembled after a
// deterministic marker.
//
// Attribution and the manual/derived split: `operator_profiles.source` and
// `operator_voice_profiles.source` ('linkedin_capture'|'manual' /
// 'derived'|'manual') work as a single column because those rows are either
// fully derived or fully hand-edited. A project description is neither - a
// human's own paragraph, plus a sources appendix that should always reflect
// the current set. A boolean here would have to lie about half the row, so
// this splits the text itself instead: everything before
// `DESCRIPTION_SOURCES_MARKER` is the human's, never touched by a
// recomputation; everything after is regenerated from scratch every time and
// carries its own attribution inline (it names every source it lists). That
// is a stronger version of the same guarantee `source` gives elsewhere - the
// write path (`acceptDescriptionProposal`) is the only thing that can move
// text past the marker, and it never runs without an explicit accept.
//
// No new table or column: a proposal is computed on demand (whatever is
// currently on `projects.description` vs. what the active source set would
// produce), and a decision (accept or decline) is recorded as a
// `project_description_refresh` run - `runs.kind` and `runs.params` are
// already free-form enough to carry it, so the only thing this needs from
// the schema is a new string in a comment (see schema.ts).
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { projectBelongsToOrg } from './orgs.js';
import { getProjectById } from './projects/index.js';
import { listProjectSources, type ProjectSourceRow } from './project-sources.js';

/**
 * Splits a description into its hand-written part and its generated sources
 * appendix. Everything from this marker onward is owned by
 * `deriveProjectDescription` and rebuilt from scratch on every call;
 * everything before it is the operator's own text and this module never
 * writes to it directly (only a full accept replaces the whole column, and
 * only with a value that still starts with the same hand-written prefix).
 */
export const DESCRIPTION_SOURCES_MARKER = '<!-- pitchbox:sources -->';

/** Kinds a description's sources appendix mentions. `folder`/`git`/`upload`
 * are the transient inputs a full extraction run already reads and writes
 * into the hand-written part of the description - listing them again here
 * would be citing the same fact twice. */
const APPENDIX_SOURCE_KINDS: Record<string, true> = {
  github: true,
  website: true,
  linkedin_company: true,
  linkedin_profile: true,
  linkedin_post: true,
};

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * One line naming a source, using whatever it has: its own cached output
 * when a fetch has succeeded, otherwise just its configured identifier - a
 * source added a moment ago (or one whose fetch failed) is still mentioned,
 * since the acceptance bar is "the description mentions it", not "and its
 * fetch already succeeded".
 */
export function describeSourceForAppendix(source: ProjectSourceRow): string {
  const config = (source.config ?? {}) as Record<string, unknown>;
  const output = (source.output ?? {}) as Record<string, unknown>;

  if (source.kind === 'github') {
    const owner = readString(config.owner);
    const repo = readString(config.repo);
    const name =
      owner && repo ? `${owner}/${repo}` : (readString(config.url) ?? 'a GitHub repository');
    const description = readString(output.description);
    return description
      ? `the GitHub repository ${name} ("${description}")`
      : `the GitHub repository ${name}`;
  }

  if (source.kind === 'website') {
    const url = readString(config.url) ?? 'a website';
    return `the website ${url}`;
  }

  // linkedin_company / linkedin_profile / linkedin_post: no fetcher has
  // shipped yet (#435 is still spiking the shape), so this reads whatever
  // identifier the config already carries rather than a kind-specific field
  // that does not exist on disk yet.
  const label = readString(config.url) ?? readString(config.handle) ?? readString(config.name);
  const kindLabel =
    source.kind === 'linkedin_company'
      ? 'LinkedIn company page'
      : source.kind === 'linkedin_profile'
        ? 'LinkedIn profile'
        : 'LinkedIn post';
  return label ? `its ${kindLabel} at ${label}` : `its ${kindLabel}`;
}

/**
 * Rebuilds a description's sources appendix from the current active set.
 * Pure and deterministic: same description text plus the same sources
 * always produces the same result, which is what makes "declining keeps the
 * old one" and "removing a source proposes one without it" provable without
 * a model in the loop.
 */
export function deriveProjectDescription(
  currentDescription: string,
  activeSources: ProjectSourceRow[],
): string {
  const base = currentDescription.split(DESCRIPTION_SOURCES_MARKER)[0]!.trimEnd();
  const appendixSources = activeSources
    .filter((s) => APPENDIX_SOURCE_KINDS[s.kind])
    .sort((a, b) => a.id - b.id);
  if (appendixSources.length === 0) return base;

  const bullets = appendixSources.map((s) => `- ${describeSourceForAppendix(s)}`).join('\n');
  return `${base}\n\n${DESCRIPTION_SOURCES_MARKER}\n## Also draws on\n${bullets}`;
}

export interface DescriptionProposal {
  proposedDescription: string;
  previousDescription: string;
  /** Which sources the appendix cites, for the audit trail an accept
   * records - the issue's "record which sources it was derived from". */
  sourceIds: number[];
}

type DescriptionRefreshParams = {
  decision: 'accepted' | 'declined';
  proposedDescription: string;
  previousDescription: string;
  sourceIds: number[];
};

/**
 * The most recent decision (accept or decline) recorded for this project, or
 * null if none exists yet.
 */
async function latestDecision(db: Db, projectId: number): Promise<DescriptionRefreshParams | null> {
  const [row] = await db
    .select({ params: schema.runs.params })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.kind, 'project_description_refresh'),
      ),
    )
    .orderBy(desc(schema.runs.id))
    .limit(1);
  if (!row) return null;
  const params = row.params as Partial<DescriptionRefreshParams>;
  if (params.decision !== 'accepted' && params.decision !== 'declined') return null;
  if (typeof params.proposedDescription !== 'string') return null;
  return params as DescriptionRefreshParams;
}

/**
 * Computes the current proposal, if any: the description the active source
 * set would produce, when it differs from what is on the project today.
 * Returns null when there is nothing to propose - either the derived text
 * already matches (nothing changed), or the operator already declined this
 * exact text and nothing has changed since (declining keeps the old one,
 * and keeps it declined until the source set actually changes again).
 */
export async function computeDescriptionProposal(
  db: Db,
  organizationId: number,
  projectId: number,
): Promise<DescriptionProposal | null> {
  if (!(await projectBelongsToOrg(db, projectId, organizationId))) return null;
  const project = await getProjectById(db, projectId);
  if (!project) return null;

  const sources = await listProjectSources(db, organizationId, projectId);
  const active = sources.filter((s) => s.active);
  const previousDescription = project.description ?? '';
  const proposedDescription = deriveProjectDescription(previousDescription, active);
  if (proposedDescription === previousDescription) return null;

  const decision = await latestDecision(db, projectId);
  if (
    decision &&
    decision.decision === 'declined' &&
    decision.proposedDescription === proposedDescription
  ) {
    return null;
  }

  const sourceIds = active.filter((s) => APPENDIX_SOURCE_KINDS[s.kind]).map((s) => s.id);
  return { proposedDescription, previousDescription, sourceIds };
}

export type DescriptionDecisionResult = { ok: true } | { ok: false; code: 'not_found' | 'stale' };

/**
 * Records a decision against the *current* proposal, re-verified against the
 * live source set rather than trusted from the caller - the source set can
 * change between the diff being shown and the operator clicking a button,
 * and applying (or suppressing) stale text would be exactly the silent
 * overwrite this feature exists to prevent.
 */
async function decide(
  db: Db,
  organizationId: number,
  projectId: number,
  proposedDescription: string,
  decision: 'accepted' | 'declined',
): Promise<DescriptionDecisionResult> {
  if (!(await projectBelongsToOrg(db, projectId, organizationId)))
    return { ok: false, code: 'not_found' };
  const fresh = await computeDescriptionProposal(db, organizationId, projectId);
  if (!fresh || fresh.proposedDescription !== proposedDescription)
    return { ok: false, code: 'stale' };

  const params: DescriptionRefreshParams = {
    decision,
    proposedDescription: fresh.proposedDescription,
    previousDescription: fresh.previousDescription,
    sourceIds: fresh.sourceIds,
  };

  if (decision === 'accepted') {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.projects)
        .set({ description: fresh.proposedDescription, updatedAt: new Date() })
        .where(eq(schema.projects.id, projectId));
      await tx.insert(schema.runs).values({
        kind: 'project_description_refresh',
        projectId,
        trigger: 'sources_changed',
        status: 'success',
        finishedAt: new Date(),
        params,
      });
    });
  } else {
    await db.insert(schema.runs).values({
      kind: 'project_description_refresh',
      projectId,
      trigger: 'sources_changed',
      status: 'success',
      finishedAt: new Date(),
      params,
    });
  }

  return { ok: true };
}

/** Applies a proposal: the project's description becomes
 * `proposedDescription`, and the decision is recorded for the audit trail. */
export function acceptDescriptionProposal(
  db: Db,
  organizationId: number,
  projectId: number,
  proposedDescription: string,
): Promise<DescriptionDecisionResult> {
  return decide(db, organizationId, projectId, proposedDescription, 'accepted');
}

/** Discards a proposal: `projects.description` is never touched, and this
 * exact text will not be proposed again until the active source set
 * changes. */
export function declineDescriptionProposal(
  db: Db,
  organizationId: number,
  projectId: number,
  proposedDescription: string,
): Promise<DescriptionDecisionResult> {
  return decide(db, organizationId, projectId, proposedDescription, 'declined');
}
