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

import { HOUSE_STYLE_HEADING, HOUSE_STYLE_SECTION } from '../house-style.js';

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

export interface ProjectVoice {
  name: string;
  description?: string | null;
  /** Active few-shot templates for this project, already filtered by kind. */
  examples?: Array<{ title: string; body: string }>;
}

/** Hard ceiling on the post text we forward. A LinkedIn post is short; anything
 * past this is either a pasted article or a hostile payload, and neither
 * improves the suggestion. */
export const MAX_POST_CHARS = 4000;
/** How many few-shot examples are worth carrying. More lengthens the prompt
 * without changing the voice, and the first token is what the human waits on. */
export const MAX_EXAMPLES = 3;

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
 * passed in, so it is testable without a database and cannot reach one.
 */
export function buildSuggestionPrompt(args: {
  kind: SuggestionKind;
  post: ObservedPost;
  project: ProjectVoice;
  /** Optional steer the human typed into the panel. */
  hint?: string;
}): string {
  const { kind, post, project } = args;
  const parts: string[] = [];

  parts.push(
    `You are drafting for ${project.name}, whose operator will read what you write, edit it if they want, and post it themselves under their own name. Nothing you write is sent by anyone but them.`,
  );
  if (project.description?.trim()) {
    parts.push(`What ${project.name} is:\n${clamp(project.description, 1200)}`);
  }

  const examples = (project.examples ?? []).slice(0, MAX_EXAMPLES);
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
  // prompt, and a suggestion wrapped in commentary is one the panel cannot show.
  parts.push(
    'Reply with the text itself and nothing else. No preamble, no quotes around it, no explanation of your choices, no options to pick from.',
  );

  return parts.join('\n\n');
}
