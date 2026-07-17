import { describe, it, expect } from 'vitest';
import {
  AutoAllowPolicy,
  ConfigurablePermissionPolicy,
  selectPermissionOption,
} from '../../../src/agents/acp/permission.js';

describe('AutoAllowPolicy', () => {
  it('always returns allow', () => {
    const policy = new AutoAllowPolicy();
    expect(policy.decide({ toolName: 'bash', args: {} })).toBe('allow');
    expect(policy.decide({ toolName: 'write_file', args: { path: '/etc/passwd' } })).toBe('allow');
    expect(policy.decide({ toolName: 'unknown_tool', args: {} })).toBe('allow');
  });
});

describe('ConfigurablePermissionPolicy', () => {
  it('allows everything when there are no rules (defaults like AutoAllow)', () => {
    const policy = new ConfigurablePermissionPolicy({ rules: [] });
    expect(policy.decide({ toolName: 'bash', args: {} })).toBe('allow');
  });

  it('denies a matching tool-kind rule while allowing everything else', () => {
    const policy = new ConfigurablePermissionPolicy({
      rules: [{ toolKind: 'bash', decision: 'reject' }],
    });
    expect(policy.decide({ toolName: 'bash', args: { cmd: 'ls' } })).toBe('reject');
    expect(policy.decide({ toolName: 'Bash', args: {} })).toBe('reject');
    expect(policy.decide({ toolName: 'read', args: {} })).toBe('allow');
  });

  it('denies a matching path-pattern rule while allowing other paths', () => {
    const policy = new ConfigurablePermissionPolicy({
      rules: [{ pathPattern: '/etc/**', decision: 'reject' }],
    });
    expect(policy.decide({ toolName: 'edit', args: { path: '/etc/passwd' } })).toBe('reject');
    expect(policy.decide({ toolName: 'edit', args: { path: '/etc/ssh/sshd_config' } })).toBe(
      'reject',
    );
    expect(policy.decide({ toolName: 'edit', args: { path: '/home/user/notes.md' } })).toBe(
      'allow',
    );
    // No path-like arg at all: the path rule cannot match, so falls through.
    expect(policy.decide({ toolName: 'edit', args: {} })).toBe('allow');
  });

  it('requires both matchers on a combined rule to match', () => {
    const policy = new ConfigurablePermissionPolicy({
      rules: [{ toolKind: 'edit', pathPattern: '/etc/**', decision: 'reject' }],
    });
    // Right tool, wrong path: allowed.
    expect(policy.decide({ toolName: 'edit', args: { path: '/home/user/notes.md' } })).toBe(
      'allow',
    );
    // Right path, wrong tool: allowed.
    expect(policy.decide({ toolName: 'read', args: { path: '/etc/passwd' } })).toBe('allow');
    // Both match: denied.
    expect(policy.decide({ toolName: 'edit', args: { path: '/etc/passwd' } })).toBe('reject');
  });

  it('evaluates rules in order, first match wins', () => {
    const policy = new ConfigurablePermissionPolicy({
      rules: [
        { pathPattern: '/etc/allowed.conf', decision: 'allow' },
        { pathPattern: '/etc/**', decision: 'reject' },
      ],
    });
    expect(policy.decide({ toolName: 'edit', args: { path: '/etc/allowed.conf' } })).toBe('allow');
    expect(policy.decide({ toolName: 'edit', args: { path: '/etc/other.conf' } })).toBe('reject');
  });

  it('falls back to a configured defaultDecision when no rule matches', () => {
    const policy = new ConfigurablePermissionPolicy({
      rules: [{ toolKind: 'read', decision: 'allow' }],
      defaultDecision: 'reject',
    });
    expect(policy.decide({ toolName: 'read', args: {} })).toBe('allow');
    expect(policy.decide({ toolName: 'bash', args: {} })).toBe('reject');
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
