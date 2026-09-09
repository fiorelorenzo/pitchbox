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
// is typing (persona, voice profile), what else they build (every project in
// the org) and what they have shipped (public repos) - see
// docs/design/DECISIONS.md and issue #312's follow-ups for why "an assistant
// that speaks for a product" was never the same thing as one that can write as
// the person behind it. Every new section is composed the same way the old
// project description was: present when its source is present, entirely
// absent otherwise, never an empty heading.
//
// 2026-09-08 (#407): the voice section stopped quoting the operator's raw
// posts and instead carries `voiceProfile`'s derived summary - a measured
// description of how they write, not a list of examples to imitate
// verbatim. Smaller, and it says something about the habit instead of
// hoping the model infers one from a handful of quotes.
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
import type { CodeRepo, OperatorPersona, ProjectBrief, VoiceProfileSummary } from './context.js';
import { describePostRegister, readPostRegister } from './register.js';
import { ASSIST_TONE_NOTES_MAX, DEFAULT_ASSIST_TONE, type AssistTone } from './tone.js';

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
  /** LinkedIn's own rendered relative-time text for the post itself (#568),
   * e.g. "6 giorni" - never a machine timestamp, the same posture
   * `ObservedComment.relativeTime` documents below. */
  relativeTime?: string;
  /** LinkedIn's own rendered reaction count on the post, as text (#568) -
   * e.g. "16". Left as the platform's own prose rather than parsed to a
   * number: the source is locale-formatted, not a machine count. */
  reactionCount?: string;
  /** LinkedIn's own rendered comment count on the post, as text (#568) -
   * e.g. "31 commenti". This is the platform's own total and can run ahead
   * of `thread.renderedCount`, which is only what the page actually loaded
   * - "300 comments already" and "two comments" call for different replies
   * even when the page rendered the same handful either way. */
  commentCount?: string;
  /** The visible comment thread (#568), when the page had one to read - the
   * SDUI feed never does (see linkedin-dom.ts's module header). */
  thread?: ObservedThread;
  /** The post's own attached media, captured as pixels from the human's
   * rendered tab (#569) - never fetched from a licdn URL, by either side;
   * see docs/design/in-page-agent.md's "capture the rendered tab, never
   * fetch licdn" rule. See `ObservedImage`'s own doc comment for what
   * absence of each of its fields means. */
  image?: ObservedImage;
}

/** What kind of rendered media `ObservedPost.image` is a crop of (#569), so
 * a description doesn't overclaim: a video post shows one frame, never the
 * video, and a carousel or document post shows whichever page LinkedIn
 * currently has on screen, never every page. */
export type ObservedImageKind = 'image' | 'video_frame' | 'carousel_page';

/** The post's attached media (#569), present on `ObservedPost` whenever the
 * post has visible media at all - independent of whether a capture of it
 * actually reached us. Three states a consumer must handle, honestly
 * distinct rather than collapsed into one "no image" case:
 *
 * - `dataUrl` set: real pixels, a `data:image/...;base64,...` URL the
 *   extension downscaled and re-encoded before the request ever left the
 *   browser, capped at `MAX_IMAGE_DATA_URL_CHARS` and re-enforced by the
 *   same cap server-side rather than trusting that clamp.
 * - `dataUrl` absent, `alt` set: the capture itself was unavailable
 *   (permission not granted, the tab was not the active one, or the media
 *   had scrolled out of the viewport) but LinkedIn rendered its own alt
 *   text for it.
 * - both absent: the post has media and neither a capture nor an alt text
 *   reached us. There is an image nobody can describe, which is worth
 *   stating to the model rather than pretending away.
 *
 * `ObservedPost.image` itself absent (not this type at all) means the post
 * carries no media whatsoever - the one case that skips a vision call
 * entirely, at no cost. */
export interface ObservedImage {
  dataUrl?: string;
  alt?: string;
  kind: ObservedImageKind;
  /** True when this is one page of a multi-page carousel or document post -
   * what is currently rendered, never every page. */
  partial?: boolean;
}

/** One rendered comment or reply in `ObservedPost.thread` (#568), mirroring
 * `LinkedInComment` in extension/src/content/shared/linkedin-dom.ts field
 * for field - the extension has no dependency on `@pitchbox/shared`, so the
 * two types cannot share a declaration, only a shape. */
export interface ObservedComment {
  id?: string;
  authorName?: string;
  authorHandle?: string;
  body: string;
  /** LinkedIn's own relative-time text, never a machine timestamp - see
   * `LinkedInComment.relativeTime`'s doc comment in linkedin-dom.ts for why. */
  relativeTime?: string;
  /** The comment this one replies to, when nested; absent for a top-level
   * comment, whose parent is the post itself. */
  parentId?: string;
}

/** The visible comment thread under a post, as the page actually rendered
 * it (#568) - not the platform's own total, which lives on `ObservedPost`
 * as `commentCount` and can run ahead of what loaded. `comments` is already
 * clamped to MAX_THREAD_COMMENTS entries, each body to MAX_COMMENT_CHARS,
 * and the combined bodies to MAX_THREAD_CHARS by the extension before the
 * request ever leaves the browser (a post with hundreds of comments must
 * not become a multi-hundred-KB request) - the zod schema on
 * `POST /api/extension/suggest` re-enforces the same three numbers rather
 * than trusting that clamp, since a stale build or a crafted request could
 * skip it. `truncated` is set the moment any cap actually cuts something,
 * so a consumer knows the thread it received is partial rather than
 * assuming it is complete. `renderedCount` is how many comment articles the
 * page actually had on screen (`findPostComments(...).length` before any
 * cap runs), never smaller than `comments.length`. */
export interface ObservedThread {
  comments: ObservedComment[];
  renderedCount: number;
  truncated: boolean;
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
/** Ceilings on `ObservedThread` (#568), the same spirit as MAX_POST_CHARS: a
 * post with hundreds of comments does not make a better suggestion by
 * forwarding all of them, only a slower and more expensive one. Three
 * separate caps because a thread can be hostile along any one axis alone -
 * few but enormous comments, or many but short ones - and MAX_THREAD_CHARS
 * is the one most likely to bind first on an ordinary long thread of
 * merely-medium comments, each individually under MAX_COMMENT_CHARS. The
 * extension clamps to these numbers before sending; the zod schema on
 * `POST /api/extension/suggest` enforces them again rather than trusting
 * that clamp. */
export const MAX_THREAD_COMMENTS = 30;
export const MAX_COMMENT_CHARS = 500;
export const MAX_THREAD_CHARS = 6000;
/** Hard ceiling on `ObservedImage.dataUrl`'s own character length (#569) - a
 * downscaled, re-encoded crop meant for a vision model, not a retina asset.
 * ~280 KB of base64 text is comfortably above what a JPEG crop capped at
 * 1024px on its longest edge and re-encoded at moderate quality produces,
 * and comfortably below anything that would bloat the request; past this
 * either the extension's own clamp failed or the request is hostile, and
 * the zod schema on `POST /api/extension/suggest` rejects it outright
 * rather than trusting that clamp. */
export const MAX_IMAGE_DATA_URL_CHARS = 280_000;
/** How many few-shot examples are worth carrying. More lengthens the prompt
 * without changing the voice, and the first token is what the human waits on. */
export const MAX_EXAMPLES = 3;
/** Ceilings on borrowed text from the companion context, same reasoning as
 * MAX_POST_CHARS: past this a prompt grows without the suggestion getting any
 * better, and every one of these sources can be arbitrarily long (an "about"
 * section, a README, a commit message someone pasted a stack trace into). */
const PERSONA_ABOUT_MAX = 1200;
/** Ceiling on the derived voice profile's summary. Replaces the old
 * per-sample cap (#407): a derived sentence or two describing a habit is a
 * fraction of what four raw posts at up to 600 chars each used to cost, and
 * the summary is generated prose (`assist/voice-profile.ts`), not a captured
 * post with no length contract - past this it would only mean the
 * derivation is padding rather than measuring. */
export const VOICE_PROFILE_MAX = 500;
/** Ceiling on a repo's README excerpt as it goes into the prompt. The cached
 * excerpt is already clamped to 1200 chars when it is fetched
 * (github-sources.ts README_EXCERPT_MAX_CHARS), a budget sized for "enough to
 * read", not "enough to spend on every suggestion". Measured on this repo's
 * own README (2026-09-08, #443): the sentence that says what the project
 * actually is runs about 130 characters, and the rest of a 1200-char excerpt
 * is Quick start commands and prerequisites - across four repos that cost
 * ~5.8KB, 38% of a realistic prompt, on boilerplate the model cannot use in a
 * comment or post. 400 keeps a title plus a couple of real sentences and cuts
 * the rest. */
export const README_EXCERPT_MAX = 400;
const COMMIT_SUBJECT_MAX = 120;
/** Ceiling on how many of the organization's projects reach the "what they
 * are building" list. This was the one section with no cap at all - every
 * project in the org went in regardless of count. Measured 2026-09-08 (#443):
 * twelve projects, a plausible count after a few years of side projects, cost
 * ~1.6KB on a realistic fixture even with each description already capped
 * below, and that grows without bound as an account ages. The current
 * project and the personal project are ranked ahead of the cut in
 * buildSuggestionPrompt below, because those are the two a suggestion can
 * actually depend on; the rest is honest context, not a requirement, so
 * losing one to the cap costs nothing the suggestion needs. */
export const MAX_PROJECTS = 6;
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
 * How each named tone (#405) is asked for. Written as one sentence each,
 * because a paragraph per option is a paragraph the model averages with
 * everything else in the prompt.
 *
 * `match-room` is deliberately not in this table: it is not an instruction
 * about a register, it is an instruction to use the register measured off the
 * post (`readPostRegister`), and it degrades to the operator's own voice when
 * the post is too short to measure. `custom` is not here either, since its
 * text is the operator's own.
 */
const TONE_INSTRUCTION: Record<Exclude<AssistTone, 'match-room' | 'custom'>, string> = {
  professional:
    'Write in a professional register: full sentences, no slang, but no corporate filler either.',
  plain:
    'Write plainly: short sentences, ordinary words, nothing that sounds like it came from a marketing page.',
  warm: 'Write warmly: address the author as a person, and let some enthusiasm show without exclamation marks.',
  technical:
    'Write technically: be specific about mechanisms, numbers and tradeoffs, and assume the reader knows the field.',
};

/**
 * A retune direction (#409): the panel's own control for regenerating one
 * draft the operator did not like, along an explicit axis, without touching
 * the org's stored tone. It travels once, with the one request that asks for
 * it, and is never written anywhere - unlike `tone`/`toneNotes` above, which
 * are read from settings and never trusted from the request body, this is
 * the one thing in the assist plane the request may legitimately carry,
 * because it names no setting at all.
 */
export const RETUNE_DIRECTIONS = ['drier', 'warmer', 'shorter'] as const;
export type RetuneDirection = (typeof RETUNE_DIRECTIONS)[number];

/** One sentence per direction, matching TONE_INSTRUCTION's own economy. The
 * precedence wrapper lives at the call site, not here, so it is stated once. */
const RETUNE_INSTRUCTION: Record<RetuneDirection, string> = {
  drier: 'cut any warmth, enthusiasm or hedging, and say the same point in fewer, plainer words.',
  warmer:
    'address the author more like a person and let real interest show, without adding exclamation marks.',
  shorter: 'say the same point in noticeably fewer words: keep only what earns its place.',
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
  /** Null when the corpus has never been large enough to derive anything
   * honest about how the operator writes - a smaller prompt, not a guessed
   * one. */
  voiceProfile: VoiceProfileSummary | null;
  /** Every project in the organization, including the current one. */
  projects: ProjectBrief[];
  repos: CodeRepo[];
  /** Active few-shot templates for this project, already filtered by kind. */
  examples?: Array<{ title: string; body: string }>;
  /** Optional steer the human typed into the panel. */
  hint?: string;
  /**
   * The org's tone setting (#405), read server-side. Absent behaves as
   * `match-room`, which is also the stored default, so an older caller
   * cannot silently get a different register than the settings page shows.
   *
   * Never taken from a request body: a tone in the suggest payload is
   * ignored on purpose (AGENTS.md, "a switch is enforced where the effect
   * happens"), which is what keeps a panel-level retune an explicit feature
   * rather than a side effect of this one.
   */
  tone?: AssistTone;
  /** The operator's own words, used only when `tone` is `custom`. */
  toneNotes?: string;
  /**
   * A retune direction (#409): the panel's own regenerate-in-a-direction
   * control. Unlike `tone`/`toneNotes`, this is read straight from the
   * request - it names no setting, so there is nothing for the server to
   * override it with. It affects this call only.
   */
  retune?: RetuneDirection;
}): string {
  const { kind, post, currentProject, persona, voiceProfile, projects, repos } = args;
  const tone: AssistTone = args.tone ?? DEFAULT_ASSIST_TONE;
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

  // How they write: a measured description of the operator's own habits
  // (`assist/voice-profile.ts`), derived from their voice samples, sent
  // messages, sent drafts and templates rather than quoted from any one of
  // them (#407). No "do not reuse the content" guard here, unlike the
  // few-shot examples below - there is no content to reuse, only a
  // description of a pattern.
  if (voiceProfile?.summary.trim()) {
    parts.push(
      `How the operator writes, based on what they have actually written: ${clamp(voiceProfile.summary, VOICE_PROFILE_MAX)}`,
    );
  }

  // What they are building: every project in the organization, so the
  // assistant can speak honestly about the operator's other work instead of
  // acting as if this product is the only thing they do. Ranked before the
  // MAX_PROJECTS cut so the current project and the personal project always
  // survive it regardless of how many other projects the organization has -
  // those two are what a suggestion can actually depend on; everything else
  // is honest context that is fine to lose past the ceiling.
  if (projects.length > 0) {
    const rankedProjects = [...projects].sort((a, b) => {
      const aRank = a.isCurrent ? 0 : a.isPersonal ? 1 : 2;
      const bRank = b.isCurrent ? 0 : b.isPersonal ? 1 : 2;
      return aRank - bRank;
    });
    parts.push(
      [
        'What the operator is building, across the whole organization. This suggestion is filed under the project marked "(this one)":',
        ...rankedProjects.slice(0, MAX_PROJECTS).map((p) => {
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

  // The tone, after the task and before the operator's steer, because that is
  // the precedence: house style outranks the tone, the operator's typed steer
  // outranks it too, and the tone outranks the model's own instinct.
  if (tone === 'match-room') {
    const room = describePostRegister(readPostRegister(post.text));
    parts.push(
      room
        ? `Match the room. The post below is written like this: ${room}. Meet it roughly halfway: keep the operator's own voice, and let the post's register decide length, formality and whether a question belongs at the end. Do not copy its emoji, hashtags or list layout unless the operator's own samples use them too.`
        : // Too short to have habits worth naming (register.ts's floor). Saying
          // "match the room" about an unmeasurable room would have the model
          // invent one, so this falls back to the voice we do know.
          "Match the room. The post is too short to read a register off, so write in the operator's own voice as the samples above show it.",
    );
  } else if (tone === 'custom') {
    const notes = args.toneNotes?.trim();
    if (notes) {
      parts.push(
        `How the operator wants this to sound, in their words: ${clamp(notes, ASSIST_TONE_NOTES_MAX)}`,
      );
    }
  } else {
    parts.push(TONE_INSTRUCTION[tone]);
  }

  // A retune direction (#409) sits right after the tone, ahead of the
  // operator's typed steer: it is a request that travels with one call, not
  // a setting, so it outranks the tone for this call only - the org's
  // stored tone is read fresh on every other suggestion, unaffected by a
  // retune that happened on a different draft. Wrapping it in one sentence
  // rather than folding a clause into `TONE_INSTRUCTION` keeps that call
  // from also rewriting the tone instruction above it, which would leave two
  // instructions arguing about the same register instead of one overriding
  // the other in order.
  if (args.retune) {
    parts.push(
      `The operator asked you to retune this one draft, which outranks the tone above but not the house style: ${RETUNE_INSTRUCTION[args.retune]}`,
    );
  }

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
