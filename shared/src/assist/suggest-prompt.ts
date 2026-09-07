// shared/src/assist/suggest-prompt.ts
//
// Composes the prompt behind the in-page assistant's suggestion endpoint
// (#312). This is not a playbook: no tools, no state, one turn, and nothing it
// produces is persisted until the human accepts it (#313 owns that).
//
// What it deliberately shares with a playbook is the house style. A suggestion
// is text that goes out under a real name, so it is held to exactly the rules a
// drafted comment is held to. The section comes from `shared/src/house-style.ts`
// rather than a second copy, and a test asserts every playbook matches it.
//
// 2026-09-07: rebuilt around `CompanionContext` (`shared/src/assist/context.ts`)
// instead of one project's name and description. The assistant now knows who
// is typing (persona, voice samples), what else they build (every project in
// the org) and what they have shipped (public repos) - see
// docs/design/DECISIONS.md and issue #312's follow-ups for why "an assistant
// that speaks for a product" was never the same thing as one that can write as
// the person behind it. Every new section is composed the same way the old
// project description was: present when its source is present, entirely
// absent otherwise, never an empty heading.
//
// The shape instruction moved here too, and it is now `envelopeInstruction()`
// (`shared/src/assist/envelope.ts`) rather than "reply with the text itself
// and nothing else": that line asked the model for a single blob, which is
// exactly what let a declined suggestion's reasoning read as something to post
// (#382). The envelope instruction asks for the split that
// `EnvelopeSplitter` parses, and it stays last for the same reason the old
// line did - it is the instruction most often lost in the middle of a prompt.

import { HOUSE_STYLE_HEADING, HOUSE_STYLE_SECTION } from '../house-style.js';
import { envelopeInstruction } from './envelope.js';
import type { CodeRepo, OperatorPersona, ProjectBrief } from './context.js';

/** The two kinds the in-page assistant can suggest. */
export type SuggestionKind = 'post_comment' | 'post';

export interface ObservedPost {
  /** The post's URN, when the page exposed one. Feed pages do not; see the
   * "Two frontends, one identifier" section of docs/linkedin-integration-design.md. */
  urn?: string;
  authorHandle?: string;
  authorName?: string;
  text: string;
  url?: string;
}

/** The project the suggestion is filed under, described the way the old
 * single-project prompt described it. Kept separate from `projects` (every
 * project in the org) because this is the one whose description is worth
 * quoting in full; the others get a one-line mention. */
export interface CurrentProject {
  name: string;
  description?: string | null;
}

/** Hard ceiling on the post text we forward. A LinkedIn post is short; anything
 * past this is either a pasted article or a hostile payload, and neither
 * improves the suggestion. */
export const MAX_POST_CHARS = 4000;
/** How many few-shot examples are worth carrying. More lengthens the prompt
 * without changing the voice, and the first token is what the human waits on. */
export const MAX_EXAMPLES = 3;
/** Ceilings on borrowed text from the companion context, same reasoning as
 * MAX_POST_CHARS: past this a prompt grows without the suggestion getting any
 * better, and every one of these sources can be arbitrarily long (an "about"
 * section, a README, a commit message someone pasted a stack trace into). */
const PERSONA_ABOUT_MAX = 1200;
const VOICE_SAMPLE_MAX = 600;
const README_EXCERPT_MAX = 1200;
const COMMIT_SUBJECT_MAX = 120;
/** A project mention in the "what they are building" list is a one-liner, not
 * a second copy of `CurrentProject`'s full description. */
const PROJECT_DESCRIPTION_MAX = 300;
/** Same reasoning, for a repo's own description line. */
const REPO_DESCRIPTION_MAX = 300;
/** How many of a repo's recent commits are worth naming. Past this it reads
 * as a changelog, not a hint at what the operator has been building. */
const MAX_COMMITS_PER_REPO = 5;

function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n[truncated]`;
}

const TASK: Record<SuggestionKind, string> = {
  post_comment:
    'Write one comment to leave on the post below. One paragraph, two at most. It has to add something the author or another reader would not already know: a specific experience, a number, a disagreement worth having. If you have nothing to add, say so in one sentence instead of padding.',
  post: 'Write one short post for this account, taking the post below as the starting point rather than something to summarise. Say one thing and stop.',
};

/**
 * Builds the single-turn prompt. Pure and synchronous: everything it needs is
 * passed in, so it is testable without a database and cannot reach one. The
 * companion context (`loadCompanionContext`) is the only async step, and it
 * lives in `context.ts`, upstream of this function.
 */
export function buildSuggestionPrompt(args: {
  kind: SuggestionKind;
  post: ObservedPost;
  currentProject: CurrentProject;
  /** Null when the operator has never captured a profile or typed one in by
   * hand - a smaller prompt, not a guessed one. */
  persona: OperatorPersona | null;
  /** Every project in the organization, including the current one. */
  projects: ProjectBrief[];
  repos: CodeRepo[];
  /** Active few-shot templates for this project, already filtered by kind. */
  examples?: Array<{ title: string; body: string }>;
  /** Optional steer the human typed into the panel. */
  hint?: string;
}): string {
  const { kind, post, currentProject, persona, projects, repos } = args;
  const parts: string[] = [];

  parts.push(
    `You are drafting for ${currentProject.name}, whose operator will read what you write, edit it if they want, and post it themselves under their own name. Nothing you write is sent by anyone but them.`,
  );
  if (currentProject.description?.trim()) {
    parts.push(`What ${currentProject.name} is:\n${clamp(currentProject.description, 1200)}`);
  }

  // Who the operator is: headline, about, experience and their own notes on
  // how they want to sound. Nothing here is guessed - it is either captured
  // off a page the operator opened themselves or typed by hand in Settings
  // (shared/src/assist/context.ts). Absent persona means this section does
  // not appear at all.
  if (persona) {
    const lines: string[] = [];
    if (persona.headline?.trim()) lines.push(`Headline: ${persona.headline.trim()}`);
    if (persona.about?.trim()) lines.push(`About: ${clamp(persona.about, PERSONA_ABOUT_MAX)}`);
    if (persona.experiences.length > 0) {
      lines.push(
        [
          'Experience:',
          ...persona.experiences.map((e) => {
            const head = [e.title, e.company].filter((v) => v?.trim()).join(' at ');
            const period = e.period?.trim() ? ` (${e.period.trim()})` : '';
            const summary = e.summary?.trim() ? `: ${e.summary.trim()}` : '';
            return `- ${head || 'Role'}${period}${summary}`;
          }),
        ].join('\n'),
      );
    }
    if (persona.notes?.trim()) {
      lines.push(`Notes from the operator on how they want to sound: ${clamp(persona.notes, 500)}`);
    }
    if (lines.length > 0) {
      parts.push(['Who is writing this:', ...lines].join('\n'));
    }
  }

  // How they write: the operator's own recent posts, offered as real
  // examples rather than an instruction to "sound professional". Explicit
  // about not reusing the content, the same guard the few-shot templates
  // below carry, because a suggestion that nails the tone but repeats
  // someone else's sentence is still a suggestion that looks copied.
  const voiceSamples = persona?.voiceSamples ?? [];
  if (voiceSamples.length > 0) {
    parts.push(
      [
        'How the operator writes. These are their own recent posts, offered as voice samples: match this voice, do not reuse the content.',
        ...voiceSamples.map((s) => `- ${clamp(s.text, VOICE_SAMPLE_MAX)}`),
      ].join('\n'),
    );
  }

  // What they are building: every project in the organization, so the
  // assistant can speak honestly about the operator's other work instead of
  // acting as if this product is the only thing they do.
  if (projects.length > 0) {
    parts.push(
      [
        'What the operator is building, across the whole organization. This suggestion is filed under the project marked "(this one)":',
        ...projects.map((p) => {
          const marker = p.isCurrent ? ' (this one)' : '';
          const desc = p.description?.trim()
            ? `: ${clamp(p.description, PROJECT_DESCRIPTION_MAX)}`
            : '';
          return `- ${p.name}${marker}${desc}`;
        }),
      ].join('\n'),
    );
  }

  // What they have shipped: public GitHub repositories, read without a
  // credential (decision 2026-09-07 - the optional GitHub App for private
  // repos is a later issue). A repo that failed to fetch or has nothing to
  // say is already filtered out by `loadCompanionContext`, so every entry
  // here is worth carrying.
  if (repos.length > 0) {
    parts.push(
      [
        'What the operator has shipped, from their public GitHub repositories:',
        ...repos.map((r) => {
          const header = `- ${r.owner}/${r.repo}${r.primaryLanguage ? ` (${r.primaryLanguage})` : ''}`;
          const desc = r.description?.trim()
            ? `\n  ${clamp(r.description, REPO_DESCRIPTION_MAX)}`
            : '';
          const readme = r.readmeExcerpt?.trim()
            ? `\n  README: ${clamp(r.readmeExcerpt, README_EXCERPT_MAX)}`
            : '';
          const commits = r.recentCommits.slice(0, MAX_COMMITS_PER_REPO);
          const commitLine = commits.length
            ? `\n  Recent commits: ${commits
                .map((c) => clamp(c.message.split('\n')[0] ?? '', COMMIT_SUBJECT_MAX))
                .join('; ')}`
            : '';
          return `${header}${desc}${readme}${commitLine}`;
        }),
      ].join('\n'),
    );
  }

  const examples = (args.examples ?? []).slice(0, MAX_EXAMPLES);
  if (examples.length > 0) {
    parts.push(
      [
        'Things this account has written before. Match this voice, do not reuse the content:',
        ...examples.map((e) => `- ${e.title}: ${clamp(e.body, 600)}`),
      ].join('\n'),
    );
  }

  const who = post.authorName ?? post.authorHandle ?? 'someone';
  parts.push(
    [
      `The post, by ${who}${post.url ? ` (${post.url})` : ''}:`,
      '"""',
      clamp(post.text, MAX_POST_CHARS),
      '"""',
    ].join('\n'),
  );

  parts.push(`Your task: ${TASK[kind]}`);

  if (args.hint?.trim()) {
    parts.push(
      `The operator added this steer, which outranks your own angle but not the house style:\n${clamp(args.hint, 500)}`,
    );
  }

  parts.push(`${HOUSE_STYLE_HEADING}${HOUSE_STYLE_SECTION}`);

  // Last, because it is the instruction most often lost in the middle of a
  // prompt, and because the reasoning/draft split (#382) only exists if the
  // model actually sees it: no marker in the response means no draft
  // (shared/src/assist/envelope.ts), so this line is the whole fail-safe's
  // upstream half.
  parts.push(envelopeInstruction());

  return parts.join('\n\n');
}
