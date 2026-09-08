import { describe, expect, it } from 'vitest';
import { describePostRegister, readPostRegister } from '../src/assist/register.js';

// #406: the half of the tone mix that comes from the room. This is a
// measurement, not a judgement, and it is a measurement precisely so the
// suggest path does not pay a second model call for something countable
// (#360/#361 made latency the constraint that decides this design).
//
// What is worth pinning: that two genuinely different registers come out
// different, that a post too short to have habits comes out as nothing rather
// than as an invented register, and that the traits it claims are traits the
// text actually has.

const CORPORATE = `Furthermore, our organisation remains committed to the delivery of
transformational outcomes across the entire value chain, whilst maintaining an
unwavering focus on stakeholder alignment and the operational excellence that
underpins sustainable growth in an increasingly competitive marketplace.`;

const CONVERSATIONAL = `I shipped it. It's rough. Three people already told me the
onboarding is confusing, and they're right. Fixing that next. What would you cut first?`;

const TECHNICAL = `We cut p99 latency from 840ms to 190ms by dropping the read-through
cache in front of Postgres. The cache was hiding a missing index on events_org_id;
once the index landed, the extra hop cost more than it saved. Full numbers in the PR.`;

describe('readPostRegister', () => {
  it('reads a corporate post and a conversational one differently', () => {
    const corporate = readPostRegister(CORPORATE);
    const conversational = readPostRegister(CONVERSATIONAL);
    expect(corporate).not.toBeNull();
    expect(conversational).not.toBeNull();

    expect(corporate!.traits).toContain('long-sentences');
    expect(corporate!.traits).toContain('formal-wording');
    expect(corporate!.traits).not.toContain('contractions');
    // "our organisation" is first person, institutionally, and the reader is
    // not asked to believe otherwise: what separates this post from the next
    // one is sentence length, formal connectives and the missing contractions,
    // not whether the pronoun is there.

    expect(conversational!.traits).toContain('short-sentences');
    expect(conversational!.traits).toContain('first-person');
    expect(conversational!.traits).toContain('contractions');
    expect(conversational!.traits).toContain('questions');

    // The point of the feature: the two descriptions cannot be the same
    // sentence, or "match the room" has nothing to match.
    expect(describePostRegister(corporate)).not.toBe(describePostRegister(conversational));
  });

  it('sees numbers and identifiers in a technical post', () => {
    const r = readPostRegister(TECHNICAL);
    expect(r!.traits).toContain('numbers');
    expect(r!.traits).toContain('code-or-jargon');
  });

  it('calls a post with no pronoun at all impersonal', () => {
    const r = readPostRegister(
      'The report finds that adoption grew across every segment, and that retention held steady in the enterprise tier throughout the period under review.',
    );
    expect(r!.traits).toContain('impersonal');
    expect(r!.traits).not.toContain('first-person');
  });

  it('says nothing about a post too short to have habits', () => {
    expect(readPostRegister('Big news soon!')).toBeNull();
    expect(readPostRegister('   ')).toBeNull();
    expect(describePostRegister(null)).toBeNull();
  });

  it('reads an Italian post rather than defaulting it to impersonal and formal', () => {
    // Half of Lorenzo's feed is Italian, so an English-only word list would
    // describe every Italian post as impersonal with no contractions, which is
    // a register the model would then match.
    const r = readPostRegister(
      'Ho passato il weekend a riscrivere il parser. Non ne sono ancora contento, ma almeno ora i test dicono la verita. Voi come lo avreste fatto?',
    );
    expect(r!.traits).toContain('first-person');
    expect(r!.traits).toContain('questions');
    expect(r!.traits).not.toContain('impersonal');
  });

  it('does not call four digits in a date a numbers habit, but does call a table of them one', () => {
    const dateOnly = readPostRegister(
      'Back in 2019 I started writing about this and nobody was interested at all, which felt about right.',
    );
    expect(dateOnly!.traits).not.toContain('numbers');
    const measured = readPostRegister(
      'Three runs: 190ms, 240ms, 210ms. The median moved 38 percent and the p99 moved more.',
    );
    expect(measured!.traits).toContain('numbers');
  });

  it('reports emoji and list layout only when they are there', () => {
    const listy = readPostRegister(
      [
        'Three things I learned shipping this:',
        '- ship it earlier',
        '- write the test',
        '- ask',
      ].join('\n'),
    );
    expect(listy!.traits).toContain('list-layout');
    expect(listy!.traits).not.toContain('emoji');

    const emoji = readPostRegister(
      'Massive week for the team and I could not be prouder of what everyone pulled off here 🚀🚀',
    );
    expect(emoji!.traits).toContain('emoji');
    expect(emoji!.traits).not.toContain('list-layout');
  });

  it('describes the numbers it measured, not a label', () => {
    const described = describePostRegister(readPostRegister(CONVERSATIONAL))!;
    expect(described).toMatch(/words per sentence/);
    expect(described).toMatch(/\d+ words/);
  });
});
