import { describe, it, expect } from 'vitest';
import { normalizeHandle } from '../src/handle-norm.js';

describe('normalizeHandle', () => {
  it('strips a Reddit u/ prefix case-insensitively', () => {
    expect(normalizeHandle('u/ALICE')).toBe('alice');
    expect(normalizeHandle('U/alice')).toBe('alice');
    expect(normalizeHandle('alice')).toBe('alice');
  });

  it('trims whitespace and lowercases', () => {
    expect(normalizeHandle('  Alice  ')).toBe('alice');
  });

  // #307: a LinkedIn account handle can be saved either as the bare vanity
  // slug or as the full profile path the connect form's own placeholder
  // suggests (linkedin.com/in/<slug>) - both must normalise to the same key
  // as whatever the content script reads off an `href` (always a bare
  // slug), or a reply never matches its own account.
  it('matches a bare LinkedIn vanity slug against its full profile-url form (both directions)', () => {
    const bare = normalizeHandle('jane-doe-123');
    const full = normalizeHandle('linkedin.com/in/jane-doe-123');
    expect(full).toBe(bare);
    expect(bare).toBe('jane-doe-123');
  });

  it('strips scheme, www subdomain, trailing slash and query/fragment noise', () => {
    expect(normalizeHandle('https://www.linkedin.com/in/Jane-Doe/')).toBe('jane-doe');
    expect(normalizeHandle('http://linkedin.com/in/Jane-Doe?miniProfileUrn=123')).toBe('jane-doe');
    expect(normalizeHandle('linkedin.com/in/Jane-Doe#about')).toBe('jane-doe');
  });

  it('does not confuse a LinkedIn profile url with a Reddit u/ handle', () => {
    // A LinkedIn slug that happens to start with "u" must not have a
    // leading "u/" stripped from it - only the profile-url branch applies.
    expect(normalizeHandle('linkedin.com/in/u-shaped-career')).toBe('u-shaped-career');
  });
});
