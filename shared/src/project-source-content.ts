// Renders a project source for the extractor agent.
//
// A `project_sources` row is either a tree the agent walks (`folder`, `git`,
// `upload`: it lists and reads files through `project_extract_files` /
// `project_extract_read`) or a cached read some fetcher already flattened
// into `output` (`website`, `mastodon_account`, `hackernews_author`, the
// LinkedIn captures). The agent should not have to know the jsonb shape of
// each fetcher, so this turns every row into the same two things: a label a
// human would recognise, and the text to read.
//
// Why this exists at all: the source set used to feed a deterministic
// appendix bolted onto the end of the description - one bullet per source,
// naming it and nothing more. That is not a description of a product, it is
// a list of URLs, and it is what a person saw after pointing Pitchbox at
// their site. The description is written by the same agent that always
// wrote it, from the same playbook, and this module is how everything a
// source fetched reaches that agent instead of being summarised into a
// bullet.

import type { ProjectSourceKind, ProjectSourceRow } from './project-sources.js';

/** Per-source cap on the text handed to the agent. Each fetcher already
 * caps its own `output.text` (website 40k, mastodon and HN 20k), so this is
 * the backstop that keeps one pathological row from crowding out the other
 * sources in a single prompt rather than the primary limit. */
export const SOURCE_CONTENT_MAX_CHARS = 40_000;

/** Kinds the agent reads as a file tree rather than as cached text. */
const TREE_KINDS: Record<string, true> = { folder: true, git: true, upload: true };

export interface AgentSourceView {
  id: number;
  kind: ProjectSourceKind;
  /** The URL, path or handle a human typed, for the agent to cite. */
  label: string;
  /** True when the content comes from `project_extract_files`/`_read`
   * instead of the `content` field below. */
  readsAsTree: boolean;
  fetchedAt: string | null;
  fetchError: string | null;
  /** Flattened cached read. Null for a tree source, and for a source
   * nothing has filled yet. */
  content: string | null;
  truncated: boolean;
}

/** The URL, path or handle behind a source, in the shape it was typed.
 * `config` is kind-specific jsonb (see project-sources.ts), so each kind's
 * own keys are read rather than assuming one field name. */
export function projectSourceLabel(source: ProjectSourceRow): string {
  const config = (source.config ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  switch (source.kind) {
    case 'website':
      return str(config.url);
    case 'mastodon_account': {
      const instanceUrl = str(config.instanceUrl);
      const acct = str(config.acct);
      return instanceUrl && acct ? `${instanceUrl}/@${acct}` : instanceUrl || acct;
    }
    case 'hackernews_author':
      return str(config.username);
    case 'linkedin_post':
    case 'linkedin_profile':
    case 'linkedin_company':
      return str(config.value) || str(config.identifier);
    default:
      return str(config.value) || str(config.url);
  }
}

function renderExperiences(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const lines: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const head = [e.title, e.company, e.period]
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .join(' - ');
    if (head) lines.push(`- ${head}`);
    if (typeof e.summary === 'string' && e.summary.trim()) lines.push(`  ${e.summary.trim()}`);
  }
  return lines;
}

/**
 * The text of a source's cached read, or null when there is nothing cached.
 * One branch per kind: every fetcher in this package already flattens its
 * own fetch into an `output.text`, and the metadata around that text (a
 * repository's language, a profile's headline) is worth naming for the
 * agent rather than dropping.
 */
function renderContent(source: ProjectSourceRow): string | null {
  const output = source.output as Record<string, unknown> | null;
  if (!output) return null;
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const parts: string[] = [];

  switch (source.kind) {
    case 'git': {
      if (str(output.description)) parts.push(`Repository summary: ${str(output.description)}`);
      if (str(output.primaryLanguage))
        parts.push(`Primary language: ${str(output.primaryLanguage)}`);
      if (str(output.readmeExcerpt)) parts.push(`README:\n${str(output.readmeExcerpt)}`);
      if (parts.length === 0 && typeof output.branchCount === 'number') {
        // `git ls-remote` proved the remote readable and nothing more: say
        // so, so the agent goes to the file tree instead of quoting this.
        parts.push(
          `Remote reachable, ${output.branchCount} branch(es). Read the tree for content.`,
        );
      }
      break;
    }
    case 'website': {
      if (typeof output.fetchedPageCount === 'number') {
        parts.push(`Crawled ${output.fetchedPageCount} page(s).`);
      }
      if (str(output.text)) parts.push(str(output.text));
      break;
    }
    case 'mastodon_account': {
      if (str(output.displayName)) parts.push(`Account: ${str(output.displayName)}`);
      if (str(output.text)) parts.push(str(output.text));
      break;
    }
    case 'hackernews_author': {
      if (str(output.username)) parts.push(`Hacker News user: ${str(output.username)}`);
      if (str(output.text)) parts.push(str(output.text));
      break;
    }
    case 'linkedin_post': {
      const author = [str(output.authorName), str(output.authorHandle)].filter(Boolean).join(' / ');
      if (author) parts.push(`Post author: ${author}`);
      if (str(output.text)) parts.push(str(output.text));
      break;
    }
    case 'linkedin_profile': {
      if (str(output.displayName)) parts.push(`Profile: ${str(output.displayName)}`);
      if (str(output.headline)) parts.push(`Headline: ${str(output.headline)}`);
      if (str(output.about)) parts.push(`About:\n${str(output.about)}`);
      const experiences = renderExperiences(output.experiences);
      if (experiences.length > 0) parts.push(`Experience:\n${experiences.join('\n')}`);
      break;
    }
    default:
      // A kind whose fetcher does not exist yet (`linkedin_company`) or one
      // added after this module: fall back to the raw jsonb rather than
      // silently dropping a read somebody did perform.
      parts.push(JSON.stringify(output));
      break;
  }

  const text = parts.join('\n\n').trim();
  return text === '' ? null : text;
}

/** One source, in the shape `project_extract_sources` hands to the agent. */
export function viewProjectSourceForAgent(source: ProjectSourceRow): AgentSourceView {
  const readsAsTree = TREE_KINDS[source.kind] === true;
  const full = readsAsTree ? null : renderContent(source);
  const truncated = full !== null && full.length > SOURCE_CONTENT_MAX_CHARS;
  return {
    id: source.id,
    kind: source.kind as ProjectSourceKind,
    label: projectSourceLabel(source),
    readsAsTree,
    fetchedAt: source.fetchedAt ? source.fetchedAt.toISOString() : null,
    fetchError: source.fetchError,
    content: truncated ? full!.slice(0, SOURCE_CONTENT_MAX_CHARS) : full,
    truncated,
  };
}
