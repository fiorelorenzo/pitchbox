import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../../src/runlog/classify-failure.js';
import type { ParsedEvent } from '../../src/runlog/types.js';

function ev(raw: string, kind: ParsedEvent['kind'] = 'unknown'): ParsedEvent {
  return {
    seq: 0,
    kind,
    payload: { type: 'unknown', eventType: 'test', raw } as ParsedEvent['payload'],
    raw,
  };
}

describe('classifyFailure', () => {
  it('returns unknown when the run succeeded', () => {
    expect(classifyFailure([], 0)).toBe('unknown');
  });

  it('detects runner_missing on ENOENT / command not found', () => {
    expect(classifyFailure([ev('claude: command not found')], 127)).toBe('runner_missing');
    expect(classifyFailure([ev('Error: spawn claude ENOENT')], 1)).toBe('runner_missing');
  });

  it('detects auth_expired on 401/403/auth markers', () => {
    expect(classifyFailure([ev('HTTP 401 Unauthorized from upstream')], 1)).toBe('auth_expired');
    expect(classifyFailure([ev('Reddit returned 403 Forbidden')], 1)).toBe('auth_expired');
    expect(classifyFailure([ev('token expired - please re-authenticate')], 1)).toBe('auth_expired');
  });

  it('detects quota_exhausted on quota / rate-limit text', () => {
    expect(classifyFailure([ev('quota exceeded for today')], 1)).toBe('quota_exhausted');
    expect(classifyFailure([ev('hit Reddit rate limit, backing off')], 1)).toBe('quota_exhausted');
  });

  it('detects network failures on common Node error codes', () => {
    expect(classifyFailure([ev('fetch failed: ECONNREFUSED 127.0.0.1:5180')], 1)).toBe('network');
    expect(classifyFailure([ev('getaddrinfo ENOTFOUND api.example.com')], 1)).toBe('network');
  });

  it('detects playbook_error from a JS stack trace', () => {
    const trace = `TypeError: undefined is not a function\n    at run (/repo/playbook.js:12:7)`;
    expect(classifyFailure([ev(trace)], 1)).toBe('playbook_error');
  });

  it('falls back to unknown for an opaque non-zero exit', () => {
    expect(classifyFailure([ev('something went wrong')], 1)).toBe('unknown');
  });

  it('prefers runner_missing over later patterns when both match', () => {
    // Bash sometimes prints both - make sure precedence is stable.
    expect(classifyFailure([ev('command not found\nHTTP 401')], 127)).toBe('runner_missing');
  });

  it('treats a missing exit code as failed', () => {
    expect(classifyFailure([ev('ECONNRESET')], null)).toBe('network');
  });
});
