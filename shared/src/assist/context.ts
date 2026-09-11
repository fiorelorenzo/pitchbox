// What the in-page companion knows, and where it comes from.
//
// Until 2026-09-07 a suggestion was written from one project's name, its
// description and up to three hand-written templates. That makes an assistant
// that can speak for a product, which is not the same thing as one that can
// write as the person behind it: it knew nothing about who was typing, what
// else they were building, or what they had actually shipped.
//
// This module is the context layer Lorenzo asked for (2026-09-07): the
// operator's own persona and voice, every project in their organization, and
// the public repositories they pointed at. Loading it is one query set here,
// composing it into a prompt is `suggest-prompt.ts`, and neither invents a
// source: an absent persona or an empty repo list is a smaller prompt, never a
// guess.
//
// 2026-09-08 (#407): the voice half stopped being the raw voice-sample list.
// `operator-voice-profile.ts` derives a summary of how the operator actually
// writes from every voice sample, sent message, sent draft and template on
// file, and this module carries that summary instead of the posts
// themselves - smaller, and it describes a habit rather than quoting one
// example of it.
//
// Where each piece comes from is worth stating, because some of it is
// constrained by the compliance boundary:
//   - persona: captured by the extension from pages the human opened
//     themselves (docs/linkedin-integration-design.md, rule 2), or typed by
//     hand in Settings;
//   - voice profile: derived from the persona's own voice samples plus
//     messages, drafts and templates already on file - no new capture;
//   - projects: this organization's own rows, each with the latest
//     `project_insights.summary_md` on file for it (LOR-181, 2026-09-10) -
//     the cheapest real upgrade over a bare name and description, and the
//     material the model needs to pick which project (if any) a suggestion
//     is actually about;
//   - repositories: GitHub's public API, read server-side and cached in
//     `github_sources`. No credential, by decision - a private repo waits for
//     the optional GitHub App.
//
// 2026-09-10 (LOR-181): `loadCompanionContext` stopped taking a
// `currentProjectId` and `ProjectBrief` stopped carrying `isCurrent`. Which
// project a suggestion is about is no longer known before this call runs -
// the model decides it, inside the same turn, from the post and this exact
// project list (`suggest-prompt.ts`, `assist/envelope.ts`'s `PROJECT_MARKER`).
// Every project in the org is loaded on equal footing; none is marked ahead
// of time.

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '../db/client.js';
import { loadVoiceProfile } from '../operator-voice-profile.js';
import { describeEditSignature } from './voice-profile.js';

export type PersonaExperience = {
  title?: string;
  company?: string;
  period?: string;
  summary?: string;
};

export type OperatorPersona = {
  handle?: string | null;
  displayName?: string | null;
  headline?: string | null;
  about?: string | null;
  experiences: PersonaExperience[];
  /** Free text the operator wrote about how they want to sound. */
  notes?: string | null;
  /** When the profile was last read off a page, if it ever was. */
  capturedAt?: string | null;
};

/** The derived voice profile's prose, as far as the prompt needs it - see
 * `operator-voice-profile.ts` for the full row (traits, evidence, source). */
export type VoiceProfileSummary = {
  summary: string;
  /** The comment-genre description alone (LOR-223), when the corpus has
   * enough of the operator's own comments to say something honest about
   * them specifically - null otherwise, including whenever `summary`
   * itself is null-equivalent. A `post_comment` suggestion prefers this
   * over `summary`: the pooled description is dominated by posts (they
   * outnumber comments in most corpora and run far longer), so it tells
   * the model the operator "usually writes with hashtags" and "closes
   * with #BuildInPublic" when writing a comment neither is true of. */
  commentSummary: string | null;
  /** What this operator habitually cuts from a draft before posting it
   * (LOR-227), as prose - null whenever there is nothing to say (too few
   * edited pairs, a signature that says nothing dominant) or the operator
   * excluded it in Settings, the same "hide this" control voice samples
   * already have. */
  editSignature: string | null;
};

export type ProjectBrief = {
  id: number;
  name: string;
  description?: string | null;
  /** The most recent `project_insights.summary_md` on file for this project
   * (LOR-181), or null when the project-insighter playbook has never run
   * for it. The cheapest real signal the model has for judging whether a
   * post is actually about this project, beyond its own name/description -
   * see `suggest-prompt.ts`'s project listing for how it is rendered. */
  insightSummary?: string | null;
};

export type CodeRepo = {
  owner: string;
  repo: string;
  url: string;
  description?: string | null;
  primaryLanguage?: string | null;
  readmeExcerpt?: string | null;
  recentCommits: Array<{ message: string; committedAt?: string | null }>;
};

export type CompanionContext = {
  persona: OperatorPersona | null;
  /** Null when the corpus has never been large enough to derive anything
   * honest - a smaller prompt, not a guessed one. */
  voiceProfile: VoiceProfileSummary | null;
  projects: ProjectBrief[];
  repos: CodeRepo[];
};

/** How many repositories are worth carrying. Past this the prompt grows
 * without saying anything new about what this person builds. */
export const MAX_REPOS = 4;

function asExperiences(value: unknown): PersonaExperience[] {
  if (!Array.isArray(value)) return [];
  const out: PersonaExperience[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const pick = (key: string): string | undefined =>
      typeof e[key] === 'string' && (e[key] as string).trim() ? (e[key] as string) : undefined;
    const exp: PersonaExperience = {
      title: pick('title'),
      company: pick('company'),
      period: pick('period'),
      summary: pick('summary'),
    };
    if (exp.title || exp.company || exp.summary) out.push(exp);
  }
  return out;
}

function asCommits(value: unknown): Array<{ message: string; committedAt?: string | null }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ message: string; committedAt?: string | null }> = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.message !== 'string' || !c.message.trim()) continue;
    out.push({
      message: c.message,
      committedAt: typeof c.committedAt === 'string' ? c.committedAt : null,
    });
  }
  return out;
}

/**
 * Loads everything the companion is allowed to know for one organization.
 *
 * Every project in the organization is loaded, each with its own latest
 * insight - the point is that the assistant can talk about the operator's
 * other work when that is the honest thing to say, and can judge which one
 * (if any) a suggestion is actually about (LOR-181). Nothing crosses an
 * organization boundary.
 */
export async function loadCompanionContext(
  db: Db,
  args: { organizationId: number },
): Promise<CompanionContext> {
  const [profileRow] = await db
    .select()
    .from(schema.operatorProfiles)
    .where(eq(schema.operatorProfiles.organizationId, args.organizationId))
    .limit(1);

  const voiceProfileRow = await loadVoiceProfile(db, args.organizationId);

  const projectRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, args.organizationId))
    .orderBy(asc(schema.projects.id));

  // Latest `project_insights` row per project, LOR-181: `projectInsights`
  // carries no organization id of its own, so scoping through the project
  // ids just loaded is what keeps this from reaching across a tenant
  // boundary. Ordered by generatedAt desc and reduced in JS to "first seen
  // per project id" rather than a DISTINCT ON - simpler, and an org's own
  // project count is small enough that this never has to be its own query
  // per project either.
  const latestInsightByProject = new Map<number, string>();
  if (projectRows.length > 0) {
    const insightRows = await db
      .select({
        projectId: schema.projectInsights.projectId,
        summaryMd: schema.projectInsights.summaryMd,
      })
      .from(schema.projectInsights)
      .where(
        inArray(
          schema.projectInsights.projectId,
          projectRows.map((p) => p.id),
        ),
      )
      .orderBy(desc(schema.projectInsights.generatedAt));
    for (const row of insightRows) {
      if (!latestInsightByProject.has(row.projectId)) {
        latestInsightByProject.set(row.projectId, row.summaryMd);
      }
    }
  }

  const repoRows = await db
    .select()
    .from(schema.githubSources)
    .where(
      and(
        eq(schema.githubSources.organizationId, args.organizationId),
        eq(schema.githubSources.active, true),
      ),
    )
    .orderBy(desc(schema.githubSources.fetchedAt))
    .limit(MAX_REPOS);

  const persona: OperatorPersona | null = profileRow
    ? {
        handle: profileRow.handle,
        displayName: profileRow.displayName,
        headline: profileRow.headline,
        about: profileRow.about,
        experiences: asExperiences(profileRow.experiences),
        notes: profileRow.notes,
        capturedAt: profileRow.capturedAt?.toISOString() ?? null,
      }
    : null;

  return {
    persona,
    // A profile that has never derived anything honest (corpus too small,
    // or measurable but with no dominant trait/phrase/word) has an empty
    // summary - treated the same as no row at all.
    voiceProfile: voiceProfileRow?.summary.trim()
      ? {
          summary: voiceProfileRow.summary,
          commentSummary: voiceProfileRow.evidence.genres.comment.summary,
          editSignature: voiceProfileRow.evidence.editSignatureExcluded
            ? null
            : describeEditSignature(voiceProfileRow.evidence.editSignature),
        }
      : null,
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      insightSummary: latestInsightByProject.get(p.id) ?? null,
    })),
    // A repo that failed to fetch has no text to contribute, so it is left out
    // of the prompt rather than carried as an empty entry. Settings is where
    // the failure is surfaced (`fetch_error`), not the prompt.
    repos: repoRows
      .filter((r) => r.readmeExcerpt || r.description || (r.recentCommits as unknown[])?.length)
      .map((r) => ({
        owner: r.owner,
        repo: r.repo,
        url: r.url,
        description: r.description,
        primaryLanguage: r.primaryLanguage,
        readmeExcerpt: r.readmeExcerpt,
        recentCommits: asCommits(r.recentCommits),
      })),
  };
}
