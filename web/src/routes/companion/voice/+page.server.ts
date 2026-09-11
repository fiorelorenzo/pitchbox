import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import {
  listVoiceSamples,
  setVoiceSampleExcluded,
  importVoiceSamples,
  type VoiceSampleGenre,
  type VoiceSampleSource,
} from '@pitchbox/shared/operator-profile';
import { parseLinkedinExportBuffer } from '@pitchbox/shared/voice-import-archive';
import {
  loadVoiceProfile,
  refreshVoiceProfile,
  saveVoiceProfileSummary,
  resetVoiceProfileToDerived,
  setEditSignatureExcluded,
  type OperatorVoiceProfileRow,
  type VoiceGenreSummary,
} from '@pitchbox/shared/operator-voice-profile';
import { describeEditSignature, type EditSignature } from '@pitchbox/shared/assist/voice-profile';

// Companion -> Voice ("how you write"), split out of the old three-card
// settings/companion page (LOR-178/LOR-179, docs/design/DECISIONS.md D35).
// Same sensitivity and gate as the persona page next door
// (companion/+page.server.ts) - the derived voice and its evidence feed
// every suggestion's prompt too - and the same reasoning for repeating
// requireRole('admin') here rather than inheriting one: see that file's
// comment.
//
// LOR-223: the `importVoice` action is the onboarding path this page was
// missing - a LinkedIn export upload that fills the corpus with posts and,
// for the first time, comments, in one step instead of weeks of passive
// browsing. It calls the exact same `parseLinkedinExportBuffer` and
// `importVoiceSamples` the `pitchbox voice:import` CLI command calls, so
// the two paths cannot drift and a fixture run through both produces the
// same rows.
export type CompanionVoiceSample = {
  id: number;
  text: string;
  url: string | null;
  postedAt: string | null;
  excluded: boolean;
  genre: VoiceSampleGenre;
  source: VoiceSampleSource;
  context: string | null;
  capturedAt: string;
};

export type CompanionVoiceProfile = {
  summary: string;
  traits: string[];
  openings: string[];
  closings: string[];
  commonWords: string[];
  wordsPerSentence: number;
  itemCount: number;
  wordCount: number;
  evidenceCounts: {
    voiceSamples: number;
    messages: number;
    drafts: number;
    templates: number;
    acceptedSuggestions: number;
  };
  /** Each genre's own description, alongside the pooled one above
   * (LOR-223) - a post and a comment are different genres of writing, so
   * "how you write" is worth reading per genre as well as pooled. */
  genres: Record<VoiceSampleGenre, VoiceGenreSummary>;
  source: 'derived' | 'manual';
  derivedAt: string | null;
  updatedAt: string;
  /** What this operator habitually cuts from a draft before posting it
   * (LOR-227) - the raw measurement, plus its prose (null below the
   * derivation floor or when it says nothing dominant) and the human's own
   * exclude toggle, the same shape voice samples already have. */
  editSignature: EditSignature;
  editSignatureDescription: string | null;
  editSignatureExcluded: boolean;
};

const MAX_VOICE_IMPORT_BYTES = 20 * 1024 * 1024;

function toVoiceProfile(row: OperatorVoiceProfileRow): CompanionVoiceProfile {
  return {
    summary: row.summary,
    traits: row.traits,
    openings: row.openings,
    closings: row.closings,
    commonWords: row.commonWords,
    wordsPerSentence: row.wordsPerSentence,
    itemCount: row.itemCount,
    wordCount: row.wordCount,
    evidenceCounts: row.evidence.counts,
    genres: row.evidence.genres,
    source: row.source,
    derivedAt: row.derivedAt ? row.derivedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    editSignature: row.evidence.editSignature,
    editSignatureDescription: describeEditSignature(row.evidence.editSignature),
    editSignatureExcluded: row.evidence.editSignatureExcluded,
  };
}

export const load: PageServerLoad = async (event) => {
  requireRole(event, 'admin');
  const orgId = await requireOrgId(event);
  const db = getDb();
  const [samples, voiceProfile] = await Promise.all([
    listVoiceSamples(db, orgId),
    loadVoiceProfile(db, orgId),
  ]);
  return {
    orgId,
    voiceSamples: samples.map((s): CompanionVoiceSample => ({
      id: s.id,
      text: s.text,
      url: s.url,
      postedAt: s.postedAt ? s.postedAt.toISOString() : null,
      excluded: s.excluded,
      genre: s.genre,
      source: s.source,
      context: s.context,
      capturedAt: s.capturedAt.toISOString(),
    })),
    voiceProfile: voiceProfile ? toVoiceProfile(voiceProfile) : null,
  };
};

function str(form: FormData, key: string): string | null {
  const raw = form.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const actions: Actions = {
  // Exclude/include, never delete: a delete would come back on the next
  // capture (schema.ts's own comment on operator_voice_samples), so this
  // action only ever flips the `excluded` flag. Also re-derives the voice
  // profile immediately (respecting a manual edit's protection), so the
  // effect of excluding a sample is visible on this same page without a
  // separate refresh click - the #407 acceptance case.
  toggleVoiceSample: async (event) => {
    requireRole(event, 'admin');
    const orgId = await requireOrgId(event);
    const form = await event.request.formData();
    const sampleId = Number(form.get('sampleId'));
    if (!Number.isInteger(sampleId)) return fail(400, { error: 'Invalid sample id' });
    const excluded = form.get('excluded') === 'true';
    await setVoiceSampleExcluded(getDb(), orgId, sampleId, excluded);
    const voiceProfile = await refreshVoiceProfile(getDb(), orgId);
    return { toggledSampleId: sampleId, voiceProfile: toVoiceProfile(voiceProfile) };
  },

  // The edit signature's own exclude control (LOR-227) - the same "hide
  // this" reversibility voice samples already have, at the granularity of
  // the whole signature rather than one row: a signature derived from a
  // few unusual edits should be dismissable without touching the database
  // by hand. Does not re-derive anything; a later refresh recomputes the
  // signature but carries this flag forward (`refreshVoiceProfile`'s own
  // comment).
  toggleEditSignature: async (event) => {
    requireRole(event, 'admin');
    const orgId = await requireOrgId(event);
    const form = await event.request.formData();
    const excluded = form.get('excluded') === 'true';
    const voiceProfile = await setEditSignatureExcluded(getDb(), orgId, excluded);
    return { voiceProfile: toVoiceProfile(voiceProfile) };
  },

  // Re-derives from the current corpus. A no-op on a `source: 'manual'` row
  // unless the human resets it first - same protection `refreshVoiceProfile`
  // gives a passive capture, since this button is reachable at any time,
  // including right after a manual edit.
  refreshVoiceProfile: async (event) => {
    requireRole(event, 'admin');
    const orgId = await requireOrgId(event);
    const voiceProfile = await refreshVoiceProfile(getDb(), orgId);
    return { voiceProfile: toVoiceProfile(voiceProfile) };
  },

  // A hand-edited voice description, same posture as saveProfile on the
  // persona page: marks the row `manual` unconditionally, so the next
  // automatic refresh (a new capture, or the button above) leaves it alone.
  saveVoiceProfile: async (event) => {
    requireRole(event, 'admin');
    const orgId = await requireOrgId(event);
    const form = await event.request.formData();
    const summary = str(form, 'summary') ?? '';
    const voiceProfile = await saveVoiceProfileSummary(getDb(), orgId, summary);
    return { voiceProfile: toVoiceProfile(voiceProfile) };
  },

  // Discards a manual edit and forces a fresh derivation - the only way
  // back to `source: 'derived'` once a human has edited the summary.
  resetVoiceProfile: async (event) => {
    requireRole(event, 'admin');
    const orgId = await requireOrgId(event);
    const voiceProfile = await resetVoiceProfileToDerived(getDb(), orgId);
    return { voiceProfile: toVoiceProfile(voiceProfile) };
  },

  // LOR-223: fills the corpus from a LinkedIn "Get a copy of your data"
  // export in one step - the onboarding path this page was missing,
  // especially for comments, which passive capture barely reaches. Calls
  // the same `parseLinkedinExportBuffer`/`importVoiceSamples` the
  // `pitchbox voice:import` CLI command calls, so an upload and a CLI run
  // against the same file produce the same rows. Refuses anything that is
  // not a recognisable export with a readable message rather than a stack
  // trace, and caps the upload size the same way other upload routes in
  // this app cap theirs.
  importVoice: async (event) => {
    requireRole(event, 'admin');
    const orgId = await requireOrgId(event);
    const form = await event.request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return fail(400, {
        importError: 'Choose a LinkedIn export file (.zip) or a Shares.csv/Comments.csv first.',
      });
    }
    if (file.size > MAX_VOICE_IMPORT_BYTES) {
      return fail(413, {
        importError: `File exceeds the ${Math.floor(MAX_VOICE_IMPORT_BYTES / (1024 * 1024))}MB limit.`,
      });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let items;
    try {
      items = parseLinkedinExportBuffer(buffer, file.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read that file.';
      // LOR-247: the guided onboarding path on this page tells a new
      // customer to request their data and upload whatever LinkedIn sends,
      // but LinkedIn actually answers with two archives - a "Basic" one
      // within minutes that never carries Shares.csv/Comments.csv, and the
      // real one up to 24 hours later. A customer following this page's own
      // instructions will hit exactly this parser error on day one.
      // LOR-267 (not landed) will make the importer read messages.csv from
      // the Basic archive instead of refusing it; until then this only
      // rewords the parser's own refusal - which archive is missing what
      // stays entirely `parseLinkedinExportBuffer`'s call, this never
      // second-guesses it - so it reads as "wrong archive, wait for the
      // other one" instead of "wrong export".
      const isMissingSharesAndComments =
        message.includes('Shares.csv') && message.includes('Comments.csv');
      return fail(400, {
        importError: isMissingSharesAndComments
          ? 'That looks like the quick "Basic" archive LinkedIn emails first - it never has your posts or comments. Wait for the second email (up to 24 hours after you requested it) and upload that archive instead.'
          : message,
      });
    }

    const db = getDb();
    const [platform] = await db
      .select({ id: schema.platforms.id })
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'linkedin'))
      .limit(1);
    if (!platform) return fail(500, { importError: 'LinkedIn platform is not configured.' });

    const { inserted, byGenre } = await importVoiceSamples(db, orgId, platform.id, items);
    const voiceProfile = await refreshVoiceProfile(db, orgId);
    return {
      imported: { inserted, byGenre },
      voiceProfile: toVoiceProfile(voiceProfile),
    };
  },
};
