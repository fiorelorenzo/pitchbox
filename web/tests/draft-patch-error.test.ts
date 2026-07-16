import { describe, expect, it } from 'vitest';
import { parseDraftPatchError } from '../src/lib/utils/draft-patch-error.js';

describe('parseDraftPatchError', () => {
  it('turns a scheduled_send_after code into a human message', () => {
    const iso = '2026-07-20T10:00:00.000Z';
    const msg = parseDraftPatchError(JSON.stringify({ message: `scheduled_send_after:${iso}` }));
    expect(msg).toContain('scheduled to send after');
    expect(msg).toContain(new Date(iso).toLocaleString());
  });

  it('turns a blocklisted code with a reason into a human message', () => {
    const msg = parseDraftPatchError(JSON.stringify({ message: 'blocklisted: spammer' }));
    expect(msg).toBe('This target is blocklisted: spammer.');
  });

  it('turns a blocklisted code with no reason into a generic human message', () => {
    const msg = parseDraftPatchError(JSON.stringify({ message: 'blocklisted: no reason' }));
    expect(msg).toBe('This target is blocklisted.');
  });

  it('falls back to the raw text when the body is not JSON', () => {
    expect(parseDraftPatchError('plain text error')).toBe('plain text error');
  });

  it('falls back to the raw text when JSON has no message field', () => {
    const raw = JSON.stringify({ error: 'version_conflict', current_version: 3 });
    expect(parseDraftPatchError(raw)).toBe(raw);
  });
});
