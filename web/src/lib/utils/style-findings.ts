// A style finding travels with a draft as `metadata.styleFindings`, written
// by `cli/src/commands/drafts.ts` (~L330-356) from `shared/src/style-check.ts`'s
// `checkStyle`. Only `{ ruleId, message, span }` survive into the jsonb
// column - `checkStyle`'s own `start`/`end` do not, because those offsets
// are only valid against the exact string it ran on, and a reviewer editing
// the body before this ever renders would silently point them at the wrong
// text. So `highlightStyleFindingSpans` below re-locates each span by
// literal text search against whatever body is on screen right now, and
// never trusts a stored offset - see docs/design/DECISIONS.md D44.

export interface StyleFinding {
  ruleId: string;
  message: string;
  span: string;
}

/** Reads `metadata.styleFindings` defensively: a hand-edited row, an old
 * draft that predates this shape, or a malformed entry renders nothing
 * rather than throwing. */
export function parseStyleFindings(
  metadata: Record<string, unknown> | null | undefined,
): StyleFinding[] {
  const raw = metadata?.styleFindings;
  if (!Array.isArray(raw)) return [];
  const findings: StyleFinding[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') continue;
    const { ruleId, message, span } = entry as Record<string, unknown>;
    if (typeof ruleId === 'string' && typeof message === 'string' && typeof span === 'string') {
      findings.push({ ruleId, message, span });
    }
  }
  return findings;
}

/** Tailwind classes for the inline highlight, built on `--destructive`
 * (`web/src/app.css`) - the same token `ProjectOverviewTab`'s danger zone
 * and the run log's error boxes already use for "this needs the reviewer's
 * attention". Named so the findings list's own span chip and the body's
 * highlighted occurrence can never drift into two different treatments of
 * the same signal. */
export const STYLE_FINDING_SPAN_CLASS = 'rounded-sm bg-destructive/15 px-0.5 text-destructive';

/**
 * Wraps the first literal occurrence of each finding's span in `<mark>`
 * inside raw markdown source - `marked` passes inline HTML through
 * unchanged, and `Markdown.svelte`'s DOMPurify profile allows `mark` and
 * `class`. A finding whose span no longer appears in `body` (edited since
 * the check ran) contributes no highlight, never an invented position, and
 * two overlapping spans keep only the earliest match so no character is
 * ever wrapped twice.
 */
export function highlightStyleFindingSpans(body: string, findings: StyleFinding[]): string {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const finding of findings) {
    if (!finding.span) continue;
    const start = body.indexOf(finding.span);
    if (start === -1) continue;
    const end = start + finding.span.length;
    if (ranges.some((r) => start < r.end && end > r.start)) continue;
    ranges.push({ start, end });
  }
  if (ranges.length === 0) return body;
  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const { start, end } of ranges) {
    out += body.slice(cursor, start);
    out += `<mark class="${STYLE_FINDING_SPAN_CLASS}">${body.slice(start, end)}</mark>`;
    cursor = end;
  }
  out += body.slice(cursor);
  return out;
}
