/**
 * `draft-detail.*` additions found while converting `DraftDetail.svelte`
 * itself (LOR-263 part two). Part one wrote the bulk of this prefix
 * (~70 keys) directly into `dict-en.ts`/`dict-it.ts` before the per-area
 * convention (`dict/README.md`) existed; these two were genuinely missing
 * from that set and land here instead of widening the shared file further.
 */
import type { Dict } from '../types.js';

export const draftDetailEn = {
  'draft-detail.toast-marked-sent': 'Marked as sent',
  'draft-detail.style-check-flagged.one': 'Style check flagged {n} issue',
  'draft-detail.style-check-flagged.other': 'Style check flagged {n} issues',
} satisfies Dict;

export const draftDetailIt = {
  'draft-detail.toast-marked-sent': 'Segnata come inviata',
  'draft-detail.style-check-flagged.one': 'Il controllo di stile ha segnalato {n} problema',
  'draft-detail.style-check-flagged.other': 'Il controllo di stile ha segnalato {n} problemi',
} satisfies Dict;
