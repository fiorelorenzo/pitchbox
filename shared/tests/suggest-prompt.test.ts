import { describe, expect, it } from 'vitest';
import {
  buildSuggestionPrompt,
  MAX_EXAMPLES,
  MAX_POST_CHARS,
} from '../src/assist/suggest-prompt.js';
import { HOUSE_STYLE_SECTION } from '../src/house-style.js';

// The prompt behind the in-page assistant. Pure, so the boundaries are worth
// pinning: a suggestion is text that goes out under a real name, and the two
// things that decide whether it is usable are the house style being present and
// the prompt not being padded with content that does not change the answer.

const post = { text: 'We cut p99 in half by dropping a cache.', authorName: 'Giulia Bianchi' };
const project = { name: 'Embertold', description: 'A world wiki for tabletop GMs.' };

describe('buildSuggestionPrompt', () => {
  it('carries the house style verbatim, not a paraphrase of it', () => {
    const prompt = buildSuggestionPrompt({ kind: 'post_comment', post, project });
    expect(prompt).toContain(HOUSE_STYLE_SECTION);
  });

  it('asks for the text alone, since the panel cannot render commentary', () => {
    const prompt = buildSuggestionPrompt({ kind: 'post_comment', post, project });
    expect(prompt).toMatch(/Reply with the text itself and nothing else/);
    // And that instruction is last, where it is least likely to be lost.
    expect(prompt.trimEnd().endsWith('no options to pick from.')).toBe(true);
  });

  it('states that the human posts it, which is the whole compliance premise', () => {
    const prompt = buildSuggestionPrompt({ kind: 'post_comment', post, project });
    expect(prompt).toMatch(/post it themselves under their own name/);
  });

  it('truncates a post longer than the cap instead of forwarding it whole', () => {
    const long = 'x'.repeat(MAX_POST_CHARS + 5000);
    const prompt = buildSuggestionPrompt({ kind: 'post_comment', post: { text: long }, project });
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
      project: { ...project, examples },
    });
    const used = examples.filter((e) => prompt.includes(e.title));
    expect(used).toHaveLength(MAX_EXAMPLES);
  });

  it('subordinates the operator hint to the house style rather than above it', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      project,
      hint: 'be blunt about the cache',
    });
    expect(prompt).toContain('be blunt about the cache');
    expect(prompt).toMatch(/outranks your own angle but not the house style/);
  });

  it('asks for different things for a comment and a post', () => {
    const comment = buildSuggestionPrompt({ kind: 'post_comment', post, project });
    const standalone = buildSuggestionPrompt({ kind: 'post', post, project });
    expect(comment).not.toBe(standalone);
    expect(comment).toMatch(/comment to leave on the post/);
    expect(standalone).toMatch(/short post for this account/);
  });

  it('never emits the typography the house style bans', () => {
    const prompt = buildSuggestionPrompt({
      kind: 'post_comment',
      post,
      project,
      hint: 'anything',
    });
    for (const char of ['\u2014', '\u2013', '\u2018', '\u2019', '\u201c', '\u201d', '\u2026']) {
      expect(prompt.includes(char), `prompt contains ${JSON.stringify(char)}`).toBe(false);
    }
  });
});
