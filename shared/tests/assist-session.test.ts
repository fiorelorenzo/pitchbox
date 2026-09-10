import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ASSIST_SESSION_TTL_MS,
  createAssistSession,
  getAssistSession,
  deleteAssistSession,
  __resetAssistSessionsForTests,
} from '../src/assist/session.js';
import type { ModelMessage } from 'ai';

/**
 * The store #576 leans on to make a retune cheap: the prior turn's own
 * conversation, kept just long enough for a human to reread a draft and
 * click a retune button, and never handed back to a caller it wasn't
 * created for.
 */

const SCOPE = { orgId: 1, kind: 'post_comment' as const };
const MESSAGES: ModelMessage[] = [{ role: 'assistant', content: 'gathered context' }];

afterEach(() => {
  __resetAssistSessionsForTests();
  vi.useRealTimers();
});

describe('createAssistSession / getAssistSession', () => {
  it('reads back exactly what was written, for the scope it was created with', () => {
    const id = createAssistSession(SCOPE, MESSAGES);
    expect(getAssistSession(id, SCOPE)).toEqual(MESSAGES);
  });

  it('returns null for an id that was never created', () => {
    expect(getAssistSession('not-a-real-session', SCOPE)).toBeNull();
  });

  it('refuses a mismatched org or kind rather than leaking cross-tenant context', () => {
    const id = createAssistSession(SCOPE, MESSAGES);
    expect(getAssistSession(id, { ...SCOPE, orgId: 2 })).toBeNull();
    expect(getAssistSession(id, { ...SCOPE, kind: 'post' })).toBeNull();
    // The real scope still works - the mismatched reads above didn't consume it.
    expect(getAssistSession(id, SCOPE)).toEqual(MESSAGES);
  });

  it('re-gathers past the session lifetime instead of answering from a stale post', () => {
    vi.useFakeTimers();
    const id = createAssistSession(SCOPE, MESSAGES);
    vi.advanceTimersByTime(ASSIST_SESSION_TTL_MS + 1);
    expect(getAssistSession(id, SCOPE)).toBeNull();
  });

  it('stays live one millisecond before the lifetime bound', () => {
    vi.useFakeTimers();
    const id = createAssistSession(SCOPE, MESSAGES);
    vi.advanceTimersByTime(ASSIST_SESSION_TTL_MS - 1);
    expect(getAssistSession(id, SCOPE)).toEqual(MESSAGES);
  });
});

describe('deleteAssistSession', () => {
  it('frees a session immediately rather than waiting on its TTL', () => {
    const id = createAssistSession(SCOPE, MESSAGES);
    deleteAssistSession(id);
    expect(getAssistSession(id, SCOPE)).toBeNull();
  });
});
