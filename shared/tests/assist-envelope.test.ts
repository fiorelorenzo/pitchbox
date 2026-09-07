import { describe, expect, it } from 'vitest';
import {
  DRAFT_MARKER,
  SKIP_MARKER,
  EnvelopeSplitter,
  envelopeInstruction,
  splitSuggestion,
} from '../src/assist/envelope.js';

/**
 * What these defend is one property: **the model's reasoning can never end up
 * in something the human can post** (#382). Every case below is a way the
 * model can fail to comply with the format, and in each of them the draft has
 * to be either the real draft or nothing - never the explanation.
 */
describe('splitSuggestion', () => {
  it('splits reasoning from the draft at the marker', () => {
    const env = splitSuggestion(
      `They ask about migrations, and I have run this.\n${DRAFT_MARKER}\nWe hit the same thing at 30 tables.`,
    );
    expect(env.reasoning).toBe('They ask about migrations, and I have run this.');
    expect(env.draft).toBe('We hit the same thing at 30 tables.');
    expect(env.skipped).toBe(false);
  });

  it('returns no draft when the model ignored the format', () => {
    const env = splitSuggestion(
      'This post is a hiring announcement, there is nothing useful to add here.',
    );
    expect(env.draft).toBeNull();
    expect(env.skipped).toBe(false);
    expect(env.reasoning).toContain('hiring announcement');
  });

  it('treats the skip marker as a state, not as text to post', () => {
    const env = splitSuggestion(
      `A career update, and the product is irrelevant to it.\n${SKIP_MARKER}\nCommenting would read as a plug.`,
    );
    expect(env.skipped).toBe(true);
    expect(env.draft).toBeNull();
    // The sentence after the marker is explanation and must stay reasoning.
    expect(env.reasoning).toContain('read as a plug');
  });

  it('takes the earlier marker when the model emits both', () => {
    const env = splitSuggestion(`why not\n${SKIP_MARKER}\nreally not\n${DRAFT_MARKER}\nbut here`);
    expect(env.skipped).toBe(true);
    expect(env.draft).toBeNull();
  });

  it('gives no draft when the marker is there but nothing follows it', () => {
    expect(splitSuggestion(`some reasoning\n${DRAFT_MARKER}\n   \n`).draft).toBeNull();
  });

  it('strips a marker that leaked into the draft body', () => {
    const env = splitSuggestion(`r\n${DRAFT_MARKER}\nkeep this ${SKIP_MARKER} and this`);
    expect(env.draft).toBe('keep this  and this');
  });
});

describe('EnvelopeSplitter', () => {
  function stream(chunks: string[]) {
    const s = new EnvelopeSplitter();
    const reasoning: string[] = [];
    const draft: string[] = [];
    for (const c of chunks) {
      const out = s.push(c);
      if (out.reasoning) reasoning.push(out.reasoning);
      if (out.draft) draft.push(out.draft);
    }
    return {
      env: s.finish(),
      streamedReasoning: reasoning.join(''),
      streamedDraft: draft.join(''),
    };
  }

  it('streams reasoning first and the draft after the marker', () => {
    const r = stream(['I ran this myself. ', `\n${DRAFT_MARKER}\n`, 'We hit ', 'the same thing.']);
    expect(r.streamedReasoning.trim()).toBe('I ran this myself.');
    expect(r.env.draft).toBe('We hit the same thing.');
    // What streams is a prefix of the final draft, not all of it: a tail as
    // long as a marker is held back until `finish()` can rule out that it is
    // the start of one. That lag is the price of never streaming half a marker
    // into the composer. The streamed text still carries the newline after the
    // marker, which the final envelope trims, so the prefix is compared
    // without it.
    const streamed = r.streamedDraft.replace(/^\s+/, '');
    expect(streamed.length).toBeGreaterThan(0);
    expect(r.env.draft?.startsWith(streamed)).toBe(true);
  });

  it('survives a marker cut in half across chunks', () => {
    const half = DRAFT_MARKER.slice(0, 8);
    const rest = DRAFT_MARKER.slice(8);
    const r = stream(['reasoning\n', half, `${rest}\n`, 'the draft']);
    expect(r.env.reasoning).toBe('reasoning');
    expect(r.env.draft).toBe('the draft');
    // The half-marker must never have been streamed as reasoning text.
    expect(r.streamedReasoning).not.toContain(half);
  });

  it('survives a marker arriving one character at a time', () => {
    const text = `why\n${DRAFT_MARKER}\nbody`;
    const r = stream(text.split(''));
    expect(r.env.reasoning).toBe('why');
    expect(r.env.draft).toBe('body');
  });

  it('yields no draft for an unstructured stream', () => {
    const r = stream(['nothing to add here', ', it is a repost']);
    expect(r.env.draft).toBeNull();
    expect(r.streamedDraft).toBe('');
    expect(r.env.reasoning).toBe('nothing to add here, it is a repost');
  });

  it('reports the skip state while streaming, and never a draft', () => {
    const s = new EnvelopeSplitter();
    s.push('a career update\n');
    const out = s.push(`${SKIP_MARKER}\nnot worth it`);
    expect(out.skipped).toBe(true);
    expect(out.draft).toBe('');
    expect(s.finish().draft).toBeNull();
  });
});

describe('envelopeInstruction', () => {
  it('names both markers, so prompt and parser cannot drift', () => {
    const text = envelopeInstruction();
    expect(text).toContain(DRAFT_MARKER);
    expect(text).toContain(SKIP_MARKER);
  });
});
