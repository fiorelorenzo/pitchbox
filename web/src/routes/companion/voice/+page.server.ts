import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { listVoiceSamples, setVoiceSampleExcluded } from '@pitchbox/shared/operator-profile';
import {
  loadVoiceProfile,
  refreshVoiceProfile,
  saveVoiceProfileSummary,
  resetVoiceProfileToDerived,
  type OperatorVoiceProfileRow,
} from '@pitchbox/shared/operator-voice-profile';

// Companion -> Voice ("how you write"), split out of the old three-card
// settings/companion page (LOR-178/LOR-179, docs/design/DECISIONS.md D35).
// Same sensitivity and gate as the persona page next door
// (companion/+page.server.ts) - the derived voice and its evidence feed
// every suggestion's prompt too - and the same reasoning for repeating
// requireRole('admin') here rather than inheriting one: see that file's
// comment.
export type CompanionVoiceSample = {
  id: number;
  text: string;
  url: string | null;
  postedAt: string | null;
  excluded: boolean;
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
  evidenceCounts: { voiceSamples: number; messages: number; drafts: number; templates: number };
  source: 'derived' | 'manual';
  derivedAt: string | null;
  updatedAt: string;
};

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
    source: row.source,
    derivedAt: row.derivedAt ? row.derivedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
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
    voiceSamples: samples.map((s): CompanionVoiceSample => ({
      id: s.id,
      text: s.text,
      url: s.url,
      postedAt: s.postedAt ? s.postedAt.toISOString() : null,
      excluded: s.excluded,
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
};
