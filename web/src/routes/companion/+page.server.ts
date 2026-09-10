import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { loadOperatorProfile, saveOperatorProfile } from '@pitchbox/shared/operator-profile';
import type { PersonaExperience } from '@pitchbox/shared/assist/context';

// Companion -> Persona ("who you are"), the landing page of the companion
// area (LOR-178/LOR-179, refines the 2026-09-07 companion decisions/D15,
// docs/design/DECISIONS.md D35). Split out of the old three-card
// settings/companion page so the fields the operator corrects most - handle,
// display name, headline, about - are the first thing open, rather than the
// first of three cards on one long scroll.
//
// The persona feeds straight into every suggestion's prompt
// (shared/src/assist/context.ts's loadCompanionContext), which makes it at
// least as sensitive as the LinkedIn assist on/off switch, so this loader
// throws requireRole('admin') on its own rather than inheriting a gate from
// a layout - companion/voice and companion/work each repeat the same call
// for the same reason: a gate inherited from a parent is a gate that gets
// forgotten once a fourth sibling route lands.
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
  const profile = await loadOperatorProfile(getDb(), orgId);
  return { profile: profile ? toPersona(profile) : null };
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
};
