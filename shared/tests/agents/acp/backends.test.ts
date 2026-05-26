import { describe, it, expect } from 'vitest';
import { ACP_BACKENDS } from '../../../src/agents/acp/backends.js';

describe('ACP_BACKENDS', () => {
  it('has all six expected backends', () => {
    expect(Object.keys(ACP_BACKENDS).sort()).toEqual(
      ['claude-code', 'codex', 'copilot', 'gemini', 'opencode', 'qwen-code'].sort(),
    );
  });

  it('every entry has the required fields', () => {
    for (const [key, spec] of Object.entries(ACP_BACKENDS)) {
      expect(spec.slug, `slug for ${key}`).toBe(key);
      expect(spec.displayName, `displayName for ${key}`).toMatch(/.+/);
      expect(spec.binary, `binary for ${key}`).toMatch(/.+/);
      expect(spec.acpArgs.length, `acpArgs for ${key}`).toBeGreaterThan(0);
    }
  });
});
