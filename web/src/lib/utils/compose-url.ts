/**
 * Build the URL the dashboard opens for composing/sending a draft. Appends:
 *   - `pitchbox_draft=<id>` so the extension knows which draft this tab is for;
 *   - `pitchbox_backend=<origin>` so the extension routes its armed/sent calls
 *     back to the backend the draft belongs to when several are paired.
 * The backend origin is this dashboard's own public origin (the one the
 * extension paired against). Omitted when unknown (e.g. server-side render).
 * See docs/extension-connection-design.md.
 */
export function composeHref(composeUrl: string, draftId: number, backendOrigin?: string): string {
  const sep = composeUrl.includes('?') ? '&' : '?';
  let out = `${composeUrl}${sep}pitchbox_draft=${draftId}`;
  if (backendOrigin) out += `&pitchbox_backend=${encodeURIComponent(backendOrigin)}`;
  return out;
}
