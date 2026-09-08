import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import {
  loadOperatorProfile,
  saveOperatorProfile,
  listVoiceSamples,
  setVoiceSampleExcluded,
} from '@pitchbox/shared/operator-profile';
import type { PersonaExperience } from '@pitchbox/shared/assist/context';
import {
  loadVoiceProfile,
  refreshVoiceProfile,
  saveVoiceProfileSummary,
  resetVoiceProfileToDerived,
  type OperatorVoiceProfileRow,
} from '@pitchbox/shared/operator-voice-profile';

// Settings -> Companion: what the in-page LinkedIn assistant knows about the
// operator (2026-09-07 decisions, docs/platforms/linkedin.md "What the
// companion knows"). This is org structural config in the same class as
// LinkedIn assist/Retention/Security (docs/permissions.md) - the persona,
// voice samples and repos here feed straight into every suggestion's prompt,
// which makes them at least as sensitive as the LinkedIn assist on/off
// switch - so the loader throws requireRole('admin') rather than narrowing
// the payload, and the rail hides the link from a non-admin for the same
// reason it hides linkedin-assist/retention/security.
export type CompanionPersona = {
  handle: string | null;
  displayName: string | null;
  headline: string | null;
  about: string | null;
  experiences: PersonaExperience[];
  notes: string | null;
  source: string;
  capturedAt: string | null;
};

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

function toPersona(row: {
  handle: string | null;
  displayName: string | null;
  headline: string | null;
  about: string | null;
  experiences: unknown;
  notes: string | null;
  source: string;
  capturedAt: Date | null;
}): CompanionPersona {
  return {
    handle: row.handle,
    displayName: row.displayName,
    headline: row.headline,
    about: row.about,
    experiences: Array.isArray(row.experiences) ? (row.experiences as PersonaExperience[]) : [],
    notes: row.notes,
    source: row.source,
    capturedAt: row.capturedAt ? row.capturedAt.toISOString() : null,
  };
}

export const load: PageServerLoad = async (event) => {
  requireRole(event, 'admin');
  const orgId = await requireOrgId(event);
  const db = getDb();
  const [profile, samples, voiceProfile] = await Promise.all([
    loadOperatorProfile(db, orgId),
    listVoiceSamples(db, orgId),
    loadVoiceProfile(db, orgId),
  ]);
  return {
    profile: profile ? toPersona(profile) : null,
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

// Experiences arrive as one JSON-encoded field (the form builds a variable
// number of title/company/period/summary rows client-side) rather than
// indexed form fields, which would need a naming scheme just to round-trip
// an array. Anything that doesn't parse into an array of plain objects is
// dropped rather than rejected: a malformed row here would otherwise block
// saving the rest of the persona.
function parseExperiences(form: FormData): PersonaExperience[] {
  const raw = form.get('experiences');
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : undefined,
      company:
        typeof entry.company === 'string' && entry.company.trim()
          ? entry.company.trim()
          : undefined,
      period:
        typeof entry.period === 'string' && entry.period.trim() ? entry.period.trim() : undefined,
      summary:
        typeof entry.summary === 'string' && entry.summary.trim()
          ? entry.summary.trim()
          : undefined,
    }))
    .filter((e) => e.title || e.company || e.period || e.summary);
}

export const actions: Actions = {
  // A hand edit always applies (source: 'manual' unconditionally) - the
  // protection saveOperatorProfile enforces against clobbering a manual row
  // only matters for the passive capture path (linkedin-profile-capture),
  // never for a manual-to-manual save of the operator's own edit.
  saveProfile: async (event) => {
    requireRole(event, 'admin');
    const orgId = await requireOrgId(event);
    const form = await event.request.formData();
    const saved = await saveOperatorProfile(getDb(), orgId, {
      handle: str(form, 'handle'),
      displayName: str(form, 'displayName'),
      headline: str(form, 'headline'),
      about: str(form, 'about'),
      experiences: parseExperiences(form),
      notes: str(form, 'notes'),
      source: 'manual',
    });
    return { profile: toPersona(saved) };
  },

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

  // A hand-edited voice description, same posture as saveProfile above:
  // marks the row `manual` unconditionally, so the next automatic refresh
  // (a new capture, or the button above) leaves it alone.
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
