import { describe, expect, it } from 'vitest';
import {
  buildSuggestionPrompt,
  MAX_EXAMPLES,
  MAX_POST_CHARS,
  MAX_PROJECTS,
  README_EXCERPT_MAX,
  RETUNE_DIRECTIONS,
  VOICE_PROFILE_MAX,
} from '../src/assist/suggest-prompt.js';
import { HOUSE_STYLE_SECTION } from '../src/house-style.js';
import { DRAFT_MARKER, SKIP_MARKER } from '../src/assist/envelope.js';
import type {
  CodeRepo,
  OperatorPersona,
  ProjectBrief,
  VoiceProfileSummary,
} from '../src/assist/context.js';

// The prompt behind the in-page assistant. Pure, so the boundaries are worth
// pinning: a suggestion is text that goes out under a real name, and the two
// things that decide whether it is usable are the house style being present and
// the prompt not being padded with content that does not change the answer.
//
// 2026-09-07: rebuilt around the companion context (persona, sibling projects,
// public repos). The property these tests defend beyond the old ones is that
// every new section is composed honestly: present with real content when its
// source is present, entirely absent - not an empty heading - when it is not.
//
// 2026-09-08 (#407): the voice section moved from a raw sample list on
// `persona` to a derived `voiceProfile` passed alongside it. The persona
// fixture below carries no voice samples any more - `assist-voice-profile`
// tests own deriving one, this file only owns rendering it into the prompt.
//
// 2026-09-10 (LOR-181): `buildSuggestionPrompt` dropped `currentProject` -
// which project (if any) a suggestion is about is no longer known ahead of
// the call, it is the model's own choice, stated per `envelope.ts`'s
// `PROJECT_MARKER`. `ProjectBrief` dropped `isCurrent` along with it: every
// project in `projects` is listed on equal footing, none marked as "the
// one" or ranked ahead of the cut.

const post = { text: 'We cut p99 in half by dropping a cache.', authorName: 'Giulia Bianchi' };
const noContext = { persona: null, voiceProfile: null, projects: [], repos: [] };

const persona: OperatorPersona = {
  handle: 'giulia-bianchi',
  displayName: 'Giulia Bianchi',
  headline: 'Founder at Embertold',
  about: 'I build tools for game masters who are tired of spreadsheets.',
  experiences: [
    {
      title: 'Founder',
      company: 'Embertold',
      period: '2024-present',
      summary: 'World wiki for GMs.',
    },
  ],
  notes: 'Blunt, short sentences, no hedging.',
  capturedAt: null,
};

const voiceProfile: VoiceProfileSummary = {
  summary:
    'Based on 12 pieces of their own writing (640 words). Usually writes with short sentences, close to speech, first person, speaking as themselves, about 11 words per sentence. Often opens with "Shipped the". Reuses these words often: shipped, team, campaign.',
  commentSummary: null,
};

const projects: ProjectBrief[] = [
  {
    id: 1,
    name: 'Embertold',
    description: 'A world wiki for tabletop GMs.',
    insightSummary: 'Comments mentioning search speed get replies; pricing posts do not.',
  },
  {
    id: 2,
    name: 'Runecast',
    description: 'Dice roller for remote tables.',
  },
];

const repos: CodeRepo[] = [
  {
    owner: 'giuliab',
    repo: 'embertold',
    url: 'https://github.com/giuliab/embertold',
    description: 'The world wiki engine.',
    primaryLanguage: 'TypeScript',
    readmeExcerpt: 'Embertold indexes campaign notes and makes them searchable.',
    recentCommits: [
      { message: 'Fix ranking for multi-word queries' },
      { message: 'Add campaign import' },
    ],
  },
];

describe('buildSuggestionPrompt', () => {
  it('carries the house style verbatim, not a paraphrase of it', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      ...noContext,
    });
    expect(prompt).toContain(HOUSE_STYLE_SECTION);
  });

  it('asks for the envelope shape rather than a single blob of text, and it is last', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      ...noContext,
    });
    expect(prompt).toContain(DRAFT_MARKER);
    expect(prompt).toContain(SKIP_MARKER);
    // Last, where it is least likely to be lost in the middle of the prompt.
    expect(prompt.trimEnd().endsWith('Do not write a draft you do not believe in.')).toBe(true);
    // The old single-blob instruction is gone: it is exactly the framing that
    // let a declined suggestion's reasoning be handed over as something to
    // post (#382).
    expect(prompt).not.toMatch(/Reply with the text itself and nothing else/);
  });

  it('states that the human posts it, which is the whole compliance premise', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      ...noContext,
    });
    expect(prompt).toMatch(/post it themselves under their own name/);
  });

  // LOR-181: the model, not a client-asserted binding, decides which project
  // (if any) a suggestion is about - so the instruction asking it to decide
  // is unconditional, present whether or not the org has any projects at
  // all, and it says explicitly that naming none is a real answer.
  it('always asks the model to decide which project, if any, this is about, and that naming none is a real answer', () => {
    const withoutProjects = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      ...noContext,
    });
    const withProjects = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      persona: null,
      voiceProfile: null,
      projects,
      repos: [],
    });
    for (const prompt of [withoutProjects, withProjects]) {
      expect(prompt).toMatch(/decide.*which project.*this suggestion is actually about/s);
      expect(prompt).toMatch(/writing in the operator's own voice.*is a real answer too/s);
      expect(prompt).toMatch(/post it themselves under their own name/);
    }
  });

  it('truncates a post longer than the cap instead of forwarding it whole', () => {
    const long = 'x'.repeat(MAX_POST_CHARS + 5000);
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post: { text: long },
      ...noContext,
    });
    expect(prompt).toContain('[truncated]');
    expect(prompt.length).toBeLessThan(long.length);
  });

  it('caps the few-shot examples', () => {
    // None of these bodies share vocabulary with `post.text`, so this also
    // exercises the recency fallback (example-selection.ts) - the property
    // this test pins is still just the cap, not the mode.
    const examples = Array.from({ length: MAX_EXAMPLES + 4 }, (_, i) => ({
      id: i + 1,
      title: `ex-${i}`,
      body: `body ${i}`,
      createdAt: new Date(2026, 0, i + 1),
    }));
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      ...noContext,
      examples,
    });
    const used = examples.filter((e) => prompt.includes(e.title));
    expect(used).toHaveLength(MAX_EXAMPLES);
  });

  it('subordinates the operator hint to the house style rather than above it', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      ...noContext,
      hint: 'be blunt about the cache',
    });
    expect(prompt).toContain('be blunt about the cache');
    expect(prompt).toMatch(/outranks your own angle but not the house style/);
  });

  it('asks for different things for a comment and a post', () => {
    const comment = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      ...noContext,
    });
    const standalone = buildSuggestionPrompt({ kind: 'post', post, ...noContext });
    expect(comment).not.toBe(standalone);
    expect(comment).toMatch(/comment to leave on the post/);
    expect(standalone).toMatch(/short post for this account/);
  });

  it('never emits the typography the house style bans', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      persona,
      voiceProfile,
      projects,
      repos,
      hint: 'anything',
    });
    for (const char of ['\u2014', '\u2013', '\u2018', '\u2019', '\u201c', '\u201d', '\u2026']) {
      expect(prompt.includes(char), `prompt contains ${JSON.stringify(char)}`).toBe(false);
    }
  });

  describe('companion context sections', () => {
    it('carries persona, voice profile, sibling projects and repo context when present', () => {
      const prompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona,
        voiceProfile,
        projects,
        repos,
      });
      // Who is writing.
      expect(prompt).toContain('Founder at Embertold');
      expect(prompt).toContain('I build tools for game masters');
      expect(prompt).toContain('Blunt, short sentences, no hedging.');
      // How they write: the derived summary, not a raw post.
      expect(prompt).toContain(voiceProfile.summary);
      expect(prompt).toMatch(/based on what they have actually written/);
      // Every project, each with its own id and, when it has one, its latest
      // insight - LOR-181: no "(this one)" marker, nothing is bound ahead of
      // the model's own choice.
      expect(prompt).toContain('[id 1] Embertold');
      expect(prompt).toContain('[id 2] Runecast');
      expect(prompt).toContain('Dice roller for remote tables.');
      expect(prompt).toContain('Comments mentioning search speed get replies');
      // What they have shipped.
      expect(prompt).toContain('giuliab/embertold');
      expect(prompt).toContain('Embertold indexes campaign notes');
      expect(prompt).toContain('Fix ranking for multi-word queries');
    });

    it('LOR-223: a post_comment suggestion prefers the comment-genre voice summary over the pooled one', () => {
      const genreVoiceProfile: VoiceProfileSummary = {
        summary:
          'Based on 12 pieces of their own writing (640 words). Often closes with "#BuildInPublic".',
        commentSummary:
          'Based on 27 of their own comments (190 words). Usually writes one short sentence.',
      };
      const commentPrompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona: null,
        voiceProfile: genreVoiceProfile,
        projects: [],
        repos: [],
      });
      expect(commentPrompt).toContain('Usually writes one short sentence.');
      expect(commentPrompt).not.toContain('#BuildInPublic');
      expect(commentPrompt).toMatch(/How the operator writes when commenting/);

      // A `post` suggestion has no comment to write - it keeps the pooled
      // summary regardless of whether a comment-genre one exists.
      const postPrompt = buildSuggestionPrompt({
        kind: 'post',
        post,
        persona: null,
        voiceProfile: genreVoiceProfile,
        projects: [],
        repos: [],
      });
      expect(postPrompt).toContain('#BuildInPublic');
      expect(postPrompt).not.toContain('Usually writes one short sentence.');
    });

    it('LOR-223: a post_comment suggestion falls back to the pooled summary when no comment-genre one was derived', () => {
      const prompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona: null,
        voiceProfile,
        projects: [],
        repos: [],
      });
      expect(prompt).toContain(voiceProfile.summary);
      expect(prompt).toMatch(/How the operator writes, based on what they have actually written/);
    });

    it('omits each section entirely, not as an empty heading, when its source is missing', () => {
      const prompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        ...noContext,
      });
      expect(prompt).not.toContain('Who is writing this');
      expect(prompt).not.toMatch(/How the operator writes/);
      expect(prompt).not.toMatch(/What the operator is building/);
      expect(prompt).not.toMatch(/What the operator has shipped/);
    });

    it('omits the voice section when a persona exists but no profile was derived', () => {
      const prompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona,
        voiceProfile: null,
        projects: [],
        repos: [],
      });
      expect(prompt).toContain('Who is writing this');
      expect(prompt).not.toMatch(/How the operator writes/);
    });

    it('clamps borrowed text instead of forwarding it whole', () => {
      const longAbout = 'a'.repeat(5000);
      const longReadme = 'b'.repeat(5000);
      const prompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona: { ...persona, about: longAbout },
        voiceProfile: null,
        projects: [],
        repos: [{ ...repos[0], readmeExcerpt: longReadme }],
      });
      expect(prompt.length).toBeLessThan(longAbout.length + longReadme.length);
      expect(prompt).toContain('[truncated]');
    });

    // LOR-181 retired the old ranking that put the bound project ahead of the
    // cut - there is no bound project any more, so the list is just the
    // org's first MAX_PROJECTS in the order the caller passed them.
    it('keeps only the first MAX_PROJECTS in list order, with no project singled out', () => {
      const manyProjects: ProjectBrief[] = Array.from({ length: MAX_PROJECTS + 5 }, (_, i) => ({
        id: 100 + i,
        name: `Project ${i}`,
        description: `Project ${i}'s own description.`,
      }));
      const prompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona: null,
        voiceProfile: null,
        projects: manyProjects,
        repos: [],
      });
      const shown = manyProjects.filter((p) => prompt.includes(p.name));
      expect(shown).toHaveLength(MAX_PROJECTS);
      // The first MAX_PROJECTS survive, in order - a project past the cut is
      // honest context lost, never something the model reorders to save.
      for (let i = 0; i < MAX_PROJECTS; i++) expect(prompt).toContain(`Project ${i}`);
      for (let i = MAX_PROJECTS; i < manyProjects.length; i++) {
        expect(prompt).not.toContain(`Project ${i}`);
      }
    });

    it('clamps the voice profile summary the same regardless of how far past the cap it runs', () => {
      const marker = 'ZZ-VOICE-OVERFLOW-ZZ';
      const justOver = `${'b'.repeat(VOICE_PROFILE_MAX + 40)}${marker}`;
      const wayOver = `${'c'.repeat(VOICE_PROFILE_MAX * 3)}${marker}`;
      const promptJustOver = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona: null,
        voiceProfile: { summary: justOver, commentSummary: null },
        projects: [],
        repos: [],
      });
      const promptWayOver = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona: null,
        voiceProfile: { summary: wayOver, commentSummary: null },
        projects: [],
        repos: [],
      });
      expect(promptJustOver).toContain('b'.repeat(VOICE_PROFILE_MAX));
      expect(promptJustOver).not.toContain(marker);
      expect(promptWayOver).not.toContain(marker);
      // A summary three times past the cap costs exactly the same as one
      // barely past it: the cap is a hard ceiling, not a soft trim.
      expect(promptJustOver.length).toBe(promptWayOver.length);
    });

    it('clamps a README excerpt tighter than the cache-time limit, regardless of raw length', () => {
      const marker = 'ZZ-README-OVERFLOW-ZZ';
      const justOver = `${'d'.repeat(README_EXCERPT_MAX + 40)}${marker}`;
      const wayOver = `${'e'.repeat(README_EXCERPT_MAX + 800)}${marker}`;
      const promptJustOver = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona: null,
        voiceProfile: null,
        projects: [],
        repos: [{ ...repos[0], readmeExcerpt: justOver }],
      });
      const promptWayOver = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        persona: null,
        voiceProfile: null,
        projects: [],
        repos: [{ ...repos[0], readmeExcerpt: wayOver }],
      });
      expect(promptJustOver).toContain('d'.repeat(README_EXCERPT_MAX));
      expect(promptJustOver).not.toContain(marker);
      expect(promptWayOver).not.toContain(marker);
      expect(promptJustOver.length).toBe(promptWayOver.length);
    });
  });
});

// LOR-198: a reply box under a comment is still a `post_comment` request,
// named additively - `replyToCommentId` sharpens the task into answering
// that one commenter rather than inventing a second `SuggestionKind`.
describe('a reply names its parent comment (LOR-198)', () => {
  it('sharpens the task around the named comment id, and drops the plain post_comment task', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post: { ...post, replyToCommentId: 'urn:li:comment:(activity:1,2)' },
      ...noContext,
    });
    expect(prompt).toContain(
      'Write one reply to the comment with id "urn:li:comment:(activity:1,2)"',
    );
    expect(prompt).toContain('read_thread');
    expect(prompt).not.toContain('Write one comment to leave on the post below');
  });

  it('leaves the ordinary post_comment task alone when nothing names a reply target', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      ...noContext,
    });
    expect(prompt).toContain('Write one comment to leave on the post below');
    expect(prompt).not.toContain('Write one reply to the comment with id');
  });

  it('is ignored for a "post" suggestion, which has no comment thread to reply into', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post',
      post: { ...post, replyToCommentId: 'urn:li:comment:(activity:1,2)' },
      ...noContext,
    });
    expect(prompt).toContain('Write one short post for this account');
    expect(prompt).not.toContain('Write one reply to the comment with id');
  });
});

// #405: the tone the operator picked in Settings, and #406's register reading
// behind its default option. The property worth pinning is that the option
// changes the instruction, that "match the room" says something specific about
// the post rather than the phrase "match the room" on its own, and that the
// house style still outranks all of it.
describe('tone (#405)', () => {
  const args = { kind: 'post_comment' as const, post, ...noContext };

  it('defaults to the mix when no tone is passed, matching the stored default', () => {
    const prompt = buildSuggestionPrompt(args);
    expect(prompt).toContain('Match the room');
    expect(buildSuggestionPrompt({ ...args, tone: 'match-room' })).toBe(prompt);
  });

  it('each named register asks for something different', () => {
    const prompts = (['professional', 'plain', 'warm', 'technical'] as const).map((tone) =>
      buildSuggestionPrompt({ ...args, tone }),
    );
    expect(new Set(prompts).size).toBe(prompts.length);
    expect(prompts[3]).toMatch(/mechanisms, numbers and tradeoffs/);
    // A named register is an instruction about how to write, not a claim
    // about the post: none of them may smuggle the room's reading back in.
    for (const p of prompts) expect(p).not.toContain('Match the room');
  });

  it('the mix names what the post is actually doing, not just the words "match the room"', () => {
    const chatty = buildSuggestionPrompt({
      ...args,
      tone: 'match-room',
      post: {
        text: "I shipped it. It's rough. Three people told me the onboarding is confusing, and they're right. What would you cut first?",
        authorName: 'Giulia Bianchi',
      },
    });
    const formal = buildSuggestionPrompt({
      ...args,
      tone: 'match-room',
      post: {
        text: 'Furthermore, the organisation remains committed to the delivery of transformational outcomes across the value chain, whilst maintaining an unwavering focus on stakeholder alignment.',
        authorName: 'Giulia Bianchi',
      },
    });
    expect(chatty).toContain('short sentences');
    expect(chatty).toContain('asks questions of the reader');
    expect(formal).toContain('long, built-up sentences');
    expect(formal).toContain('formal connectives');
    expect(chatty).not.toBe(formal);
  });

  it('falls back to the operator voice when the post is too short to read', () => {
    const prompt = buildSuggestionPrompt({
      ...args,
      tone: 'match-room',
      post: { text: 'Big news soon!', authorName: 'Giulia Bianchi' },
    });
    expect(prompt).toContain("write in the operator's own voice");
    expect(prompt).not.toContain('words per sentence');
  });

  it('the free-text tone goes in as the operator wrote it, and an empty one adds nothing', () => {
    const withNotes = buildSuggestionPrompt({
      ...args,
      tone: 'custom',
      toneNotes: 'Dry, a bit impatient, never enthusiastic.',
    });
    expect(withNotes).toContain('Dry, a bit impatient, never enthusiastic.');
    expect(withNotes).not.toContain('Match the room');

    const empty = buildSuggestionPrompt({ ...args, tone: 'custom', toneNotes: '   ' });
    expect(empty).not.toContain('How the operator wants this to sound');
    expect(empty).not.toContain('Match the room');
  });

  it('keeps the house style and the envelope instruction under every tone', () => {
    for (const tone of ['match-room', 'professional', 'plain', 'warm', 'technical'] as const) {
      const prompt = buildSuggestionPrompt({ ...args, tone });
      expect(prompt).toContain(HOUSE_STYLE_SECTION);
      expect(prompt).toContain(DRAFT_MARKER);
      // Precedence, as rendered: task, then tone, then house style last but
      // one. A tone that lands after the house style would be the thing the
      // model reads as final.
      expect(prompt.indexOf('Your task:')).toBeLessThan(prompt.indexOf(HOUSE_STYLE_SECTION));
    }
  });
});

// #409: the panel's own retune control - a direction the operator picked by
// clicking a button, not typed, and never written to the org's stored tone.
// The property worth pinning: it reaches the prompt, it says something
// different per direction, and it is ordered so it outranks the tone
// without deleting or rewriting the tone's own instruction.
describe('retune (#409)', () => {
  const args = { kind: 'post_comment' as const, post, ...noContext };

  it('adds nothing when no direction was asked for', () => {
    const prompt = buildSuggestionPrompt(args);
    expect(prompt).not.toContain('retune');
  });

  it('each direction says something different', () => {
    const prompts = RETUNE_DIRECTIONS.map((retune) => buildSuggestionPrompt({ ...args, retune }));
    expect(new Set(prompts).size).toBe(prompts.length);
    expect(prompts[0]).toContain('fewer, plainer words');
    expect(prompts[1]).toContain('let real interest show');
    expect(prompts[2]).toContain('keep only what earns its place');
  });

  it('outranks the tone for this call without deleting or rewriting the tone instruction', () => {
    const prompt = buildSuggestionPrompt({ ...args, tone: 'plain', retune: 'warmer' });
    // The tone instruction is still there, verbatim - the retune is ordered
    // after it and says explicitly that it outranks it, rather than a second
    // instruction that contradicts the first.
    expect(prompt).toContain('Write plainly');
    expect(prompt).toContain('outranks the tone above');
    expect(prompt.indexOf('Write plainly')).toBeLessThan(prompt.indexOf('outranks the tone above'));
  });

  it('sits under the house style, same as the tone and the operator steer', () => {
    const prompt = buildSuggestionPrompt({ ...args, retune: 'shorter' });
    expect(prompt).toContain(HOUSE_STYLE_SECTION);
    expect(prompt.indexOf('outranks the tone above')).toBeLessThan(
      prompt.indexOf(HOUSE_STYLE_SECTION),
    );
  });
});
