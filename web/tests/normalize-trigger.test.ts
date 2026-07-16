import { describe, expect, it } from 'vitest';
import { normalizeTrigger } from '../src/routes/api/run/+server.js';

// The daemon keyword-watcher dispatches with trigger:'keyword'; before the fix
// the route's allow-list omitted it and silently downgraded such runs to
// 'manual'. This exercises the normalization directly, without the full
// dispatch path (which needs an installed agent CLI and is not CI-portable).
describe('normalizeTrigger', () => {
  it('keeps every allow-listed trigger, including keyword', () => {
    for (const t of ['manual', 'scheduled', 'api', 'keyword']) {
      expect(normalizeTrigger(t)).toBe(t);
    }
  });

  it('falls back to manual for unknown or missing triggers', () => {
    expect(normalizeTrigger('bogus')).toBe('manual');
    expect(normalizeTrigger(undefined)).toBe('manual');
    expect(normalizeTrigger('')).toBe('manual');
  });
});
