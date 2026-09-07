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
// Where each piece comes from is worth stating, because one of them is
// constrained by the compliance boundary:
//   - persona and voice samples: captured by the extension from pages the
//     human opened themselves (docs/linkedin-integration-design.md, rule 2),
//     or typed by hand in Settings;
//   - projects: this organization's own rows;
//   - repositories: GitHub's public API, read server-side and cached in
//     `github_sources`. No credential, by decision - a private repo waits for
//     the optional GitHub App.

import { and, asc, desc, eq } from 'drizzle-orm';
import { schema, type Db } from '../db/client.js';
import { PERSONAL_PROJECT_SLUG } from '../personal-project.js';

export type PersonaExperience = {
  title?: string;
  company?: string;
  period?: string;
  summary?: string;
};

export type VoiceSample = {
  text: string;
  url?: string | null;
  postedAt?: string | null;
};

export type OperatorPersona = {
  handle?: string | null;
  displayName?: string | null;
  headline?: string | null;
  about?: string | null;
  experiences: PersonaExperience[];
  /** Free text the operator wrote about how they want to sound. */
  notes?: string | null;
  /** The operator's own recent posts, as examples of how they write. */
  voiceSamples: VoiceSample[];
  /** When the profile was last read off a page, if it ever was. */
  capturedAt?: string | null;
};

export type ProjectBrief = {
  id: number;
  name: string;
  description?: string | null;
  /** True for the `personal` project, which is the operator, not a product. */
  isPersonal: boolean;
  /** True for the project this suggestion is being written under. */
  isCurrent: boolean;
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
  projects: ProjectBrief[];
  repos: CodeRepo[];
};

/** How many voice samples are worth carrying. Past this the prompt grows
 * without the voice getting any clearer, and the operator waits longer for the
 * first token. */
export const MAX_VOICE_SAMPLES = 4;
/** Same reasoning for repositories: enough to say what this person builds. */
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
 * `currentProjectId` only marks which project the suggestion is being written
 * under - every project in the organization is loaded either way, because the
 * point is that the assistant can talk about the operator's other work when
 * that is the honest thing to say. Nothing crosses an organization boundary.
 */
export async function loadCompanionContext(
  db: Db,
  args: { organizationId: number; currentProjectId: number },
): Promise<CompanionContext> {
  const [profileRow] = await db
    .select()
    .from(schema.operatorProfiles)
    .where(eq(schema.operatorProfiles.organizationId, args.organizationId))
    .limit(1);

  const sampleRows = profileRow
    ? await db
        .select()
        .from(schema.operatorVoiceSamples)
        .where(
          and(
            eq(schema.operatorVoiceSamples.organizationId, args.organizationId),
            eq(schema.operatorVoiceSamples.excluded, false),
          ),
        )
        .orderBy(desc(schema.operatorVoiceSamples.postedAt))
        .limit(MAX_VOICE_SAMPLES)
    : [];

  const projectRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, args.organizationId))
    .orderBy(asc(schema.projects.id));

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
        voiceSamples: sampleRows.map((s) => ({
          text: s.text,
          url: s.url,
          postedAt: s.postedAt?.toISOString() ?? null,
        })),
      }
    : null;

  return {
    persona,
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      isPersonal: p.slug === PERSONAL_PROJECT_SLUG,
      isCurrent: p.id === args.currentProjectId,
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
