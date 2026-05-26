import { describe, it, expect } from 'vitest';
import { AutoAllowPolicy } from '../../../src/agents/acp/permission.js';

describe('AutoAllowPolicy', () => {
  it('always returns allow', () => {
    const policy = new AutoAllowPolicy();
    expect(policy.decide({ toolName: 'bash', args: {} })).toBe('allow');
    expect(policy.decide({ toolName: 'write_file', args: { path: '/etc/passwd' } })).toBe('allow');
    expect(policy.decide({ toolName: 'unknown_tool', args: {} })).toBe('allow');
  });
});
