import { parseDraftPatchError } from './draft-patch-error.js';

/**
 * Outcome of a `PATCH /inbox/[id]` request, shared by the inbox list and
 * `DraftDetail` so a version conflict is handled the same way everywhere:
 * reload and show one friendly toast instead of the generic "Action failed"
 * error.
 */
export type DraftPatchOutcome =
  { kind: 'ok' } | { kind: 'version_conflict' } | { kind: 'error'; message: string };

/**
 * Thrown by callers once a version conflict has already been surfaced (via
 * `interpretDraftPatchResponse` + a toast), so the generic catch blocks can
 * recognise it and skip piling a second "Action failed" toast on top.
 */
export class DraftVersionConflictError extends Error {
  constructor() {
    super('version_conflict');
    this.name = 'DraftVersionConflictError';
  }
}

/**
 * Reads a `PATCH /inbox/[id]` response and classifies it. A `409` with the
 * `{"error":"version_conflict"}` body (see `updateDraftWithVersion`) is
 * distinguished from every other failure so callers can reload instead of
 * showing a raw error message.
 */
export async function interpretDraftPatchResponse(res: Response): Promise<DraftPatchOutcome> {
  if (res.ok) return { kind: 'ok' };
  const text = await res.text();
  if (res.status === 409) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { error?: unknown }).error === 'version_conflict'
      ) {
        return { kind: 'version_conflict' };
      }
    } catch {
      // Not JSON - fall through to the generic error path below.
    }
  }
  return { kind: 'error', message: parseDraftPatchError(text) };
}
