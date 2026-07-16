/**
 * Turn the raw response body of a failed `PATCH /inbox/[id]` (or the
 * extension's `/api/extension/draft/[id]/sent`) request into a human-readable
 * message for the toast.
 *
 * SvelteKit's `error(409, '<code>')` serializes to `{"message":"<code>"}` on
 * the wire, so `text` is usually that JSON envelope - but callers pass the
 * raw `await res.text()`, so this also tolerates plain text and unknown JSON
 * shapes by falling back to the original string.
 */
export function parseDraftPatchError(text: string): string {
  let code = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { message?: unknown }).message === 'string'
    ) {
      code = (parsed as { message: string }).message;
    }
  } catch {
    // Not JSON - use the raw text as-is.
  }

  if (code.startsWith('scheduled_send_after:')) {
    const raw = code.slice('scheduled_send_after:'.length);
    const when = new Date(raw);
    const formatted = Number.isNaN(when.getTime()) ? raw : when.toLocaleString();
    return `This draft is scheduled to send after ${formatted}.`;
  }

  if (code.startsWith('blocklisted:')) {
    const reason = code.slice('blocklisted:'.length).trim();
    return reason && reason !== 'no reason'
      ? `This target is blocklisted: ${reason}.`
      : 'This target is blocklisted.';
  }

  return code;
}
