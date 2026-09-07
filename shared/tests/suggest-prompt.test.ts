import { describe, expect, it } from 'vitest';
import {
  buildSuggestionPrompt,
  MAX_EXAMPLES,
  MAX_POST_CHARS,
  type CurrentProject,
} from '../src/assist/suggest-prompt.js';
import { HOUSE_STYLE_SECTION } from '../src/house-style.js';
import { DRAFT_MARKER, SKIP_MARKER } from '../src/assist/envelope.js';
import type { CodeRepo, OperatorPersona, ProjectBrief } from '../src/assist/context.js';

// The prompt behind the in-page assistant. Pure, so the boundaries are worth
// pinning: a suggestion is text that goes out under a real name, and the two
// things that decide whether it is usable are the house style being present and
// the prompt not being padded with content that does not change the answer.
//
// 2026-09-07: rebuilt around the companion context (persona, sibling projects,
// public repos). The property these tests defend beyond the old ones is that
// every new section is composed honestly: present with real content when its
// source is present, entirely absent - not an empty heading - when it is not.

const post = { text: 'We cut p99 in half by dropping a cache.', authorName: 'Giulia Bianchi' };
const currentProject: CurrentProject = {
  name: 'Embertold',
  description: 'A world wiki for tabletop GMs.',
};
const noContext = { persona: null, projects: [], repos: [] };

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
  voiceSamples: [
    { text: 'Shipped campaign search today. Took three tries to get the ranking right.' },
  ],
  capturedAt: null,
};

const projects: ProjectBrief[] = [
  {
    id: 1,
    name: 'Embertold',
    description: 'A world wiki for tabletop GMs.',
    isPersonal: false,
    isCurrent: true,
  },
  {
    id: 2,
    name: 'Runecast',
    description: 'Dice roller for remote tables.',
    isPersonal: false,
    isCurrent: false,
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
      currentProject,
      ...noContext,
    });
    expect(prompt).toContain(HOUSE_STYLE_SECTION);
  });

  it('asks for the envelope shape rather than a single blob of text, and it is last', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      currentProject,
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
      currentProject,
      ...noContext,
    });
    expect(prompt).toMatch(/post it themselves under their own name/);
  });

  it('truncates a post longer than the cap instead of forwarding it whole', () => {
    const long = 'x'.repeat(MAX_POST_CHARS + 5000);
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post: { text: long },
      currentProject,
      ...noContext,
    });
    expect(prompt).toContain('[truncated]');
    expect(prompt.length).toBeLessThan(long.length);
  });

  it('caps the few-shot examples', () => {
    const examples = Array.from({ length: MAX_EXAMPLES + 4 }, (_, i) => ({
      title: `ex-${i}`,
      body: `body ${i}`,
    }));
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      currentProject,
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
      currentProject,
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
      currentProject,
      ...noContext,
    });
    const standalone = buildSuggestionPrompt({ kind: 'post', post, currentProject, ...noContext });
    expect(comment).not.toBe(standalone);
    expect(comment).toMatch(/comment to leave on the post/);
    expect(standalone).toMatch(/short post for this account/);
  });

  it('never emits the typography the house style bans', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      currentProject,
      persona,
      projects,
      repos,
      hint: 'anything',
    });
    for (const char of ['\u2014', '\u2013', '\u2018', '\u2019', '\u201c', '\u201d', '\u2026']) {
      expect(prompt.includes(char), `prompt contains ${JSON.stringify(char)}`).toBe(false);
    }
  });

  describe('companion context sections', () => {
    it('carries persona, sibling projects and repo context when present', () => {
      const prompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        currentProject,
        persona,
        projects,
        repos,
      });
      // Who is writing.
      expect(prompt).toContain('Founder at Embertold');
      expect(prompt).toContain('I build tools for game masters');
      expect(prompt).toContain('Blunt, short sentences, no hedging.');
      // How they write.
      expect(prompt).toContain('Shipped campaign search today.');
      expect(prompt).toMatch(/match this voice, do not reuse the content/);
      // Every project, including the sibling not bound to this suggestion,
      // with the current one marked.
      expect(prompt).toContain('Embertold (this one)');
      expect(prompt).toContain('Runecast');
      expect(prompt).toContain('Dice roller for remote tables.');
      // What they have shipped.
      expect(prompt).toContain('giuliab/embertold');
      expect(prompt).toContain('Embertold indexes campaign notes');
      expect(prompt).toContain('Fix ranking for multi-word queries');
    });

    it('omits each section entirely, not as an empty heading, when its source is missing', () => {
      const prompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        currentProject,
        ...noContext,
      });
      expect(prompt).not.toContain('Who is writing this');
      expect(prompt).not.toMatch(/How the operator writes/);
      expect(prompt).not.toMatch(/What the operator is building/);
      expect(prompt).not.toMatch(/What the operator has shipped/);
    });

    it('omits the voice section when a persona exists but has no voice samples', () => {
      const prompt = buildSuggestionPrompt({
        kind: 'post_comment',
        post,
        currentProject,
        persona: { ...persona, voiceSamples: [] },
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
        currentProject,
        persona: { ...persona, about: longAbout },
        projects: [],
        repos: [{ ...repos[0], readmeExcerpt: longReadme }],
      });
      expect(prompt.length).toBeLessThan(longAbout.length + longReadme.length);
      expect(prompt).toContain('[truncated]');
    });
  });
});
