import { describe, expect, it } from 'vitest';
import { DESCRIPTION_SCAFFOLD, SCAFFOLD_SECTIONS } from '../../src/project-extraction/scaffold';

describe('description scaffold', () => {
  it('lists the canonical sections in order', () => {
    expect(SCAFFOLD_SECTIONS).toEqual([
      'Product',
      'Target audience',
      'Voice & tone',
      'Offer',
      'Key features',
      'Links',
    ]);
  });

  it('renders a markdown body with each section as ## heading', () => {
    for (const s of SCAFFOLD_SECTIONS) {
      expect(DESCRIPTION_SCAFFOLD).toContain(`## ${s}`);
    }
  });
});
