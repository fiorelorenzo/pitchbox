import { describe, it, expect } from 'vitest';
import { AutoAllowPolicy, selectPermissionOption } from '../../../src/agents/acp/permission.js';

describe('AutoAllowPolicy', () => {
  it('always returns allow', () => {
    const policy = new AutoAllowPolicy();
    expect(policy.decide({ toolName: 'bash', args: {} })).toBe('allow');
    expect(policy.decide({ toolName: 'write_file', args: { path: '/etc/passwd' } })).toBe('allow');
    expect(policy.decide({ toolName: 'unknown_tool', args: {} })).toBe('allow');
  });
});

describe('selectPermissionOption', () => {
  const toolOptions = [
    { optionId: 'allow_always', kind: 'allow_always' },
    { optionId: 'allow', kind: 'allow_once' },
    { optionId: 'reject', kind: 'reject_once' },
  ];

  it('picks the allow_always option for an allow decision', () => {
    expect(selectPermissionOption(toolOptions, 'allow')?.optionId).toBe('allow_always');
  });

  it('falls back to allow_once when allow_always is not offered', () => {
    const opts = [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    expect(selectPermissionOption(opts, 'allow')?.optionId).toBe('allow');
  });

  it('picks a reject option for a reject decision', () => {
    expect(selectPermissionOption(toolOptions, 'reject')?.optionId).toBe('reject');
  });

  it('matches by optionId substring when kind is absent', () => {
    const opts = [{ optionId: 'allow-this-once' }, { optionId: 'deny-it' }];
    expect(selectPermissionOption(opts, 'allow')?.optionId).toBe('allow-this-once');
    expect(selectPermissionOption(opts, 'reject')?.optionId).toBe('deny-it');
  });

  it('returns null when no suitable option is offered', () => {
    expect(selectPermissionOption([], 'allow')).toBeNull();
    expect(
      selectPermissionOption([{ optionId: 'allow', kind: 'allow_once' }], 'reject'),
    ).toBeNull();
  });
});
