import { describe, expect, it } from 'vitest';
import {
  interpretDraftPatchResponse,
  DraftVersionConflictError,
} from '../src/lib/utils/draft-patch-response.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('interpretDraftPatchResponse', () => {
  it('returns ok for a successful response', async () => {
    const outcome = await interpretDraftPatchResponse(jsonResponse(200, { ok: true }));
    expect(outcome).toEqual({ kind: 'ok' });
  });

  it('returns version_conflict for a 409 version_conflict body', async () => {
    const outcome = await interpretDraftPatchResponse(
      jsonResponse(409, { error: 'version_conflict', current_version: 3 }),
    );
    expect(outcome).toEqual({ kind: 'version_conflict' });
  });

  it('turns other 409 codes into a human message', async () => {
    const outcome = await interpretDraftPatchResponse(
      jsonResponse(409, { message: 'blocklisted: spammer' }),
    );
    expect(outcome).toEqual({ kind: 'error', message: 'This target is blocklisted: spammer.' });
  });

  it('turns a non-JSON failure body into a generic error', async () => {
    const outcome = await interpretDraftPatchResponse(
      new Response('draft is still being drafted', { status: 409 }),
    );
    expect(outcome).toEqual({ kind: 'error', message: 'draft is still being drafted' });
  });
});

describe('DraftVersionConflictError', () => {
  it('is distinguishable from a generic Error so callers can skip the "Action failed" toast', () => {
    const err = new DraftVersionConflictError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DraftVersionConflictError);
  });
});
