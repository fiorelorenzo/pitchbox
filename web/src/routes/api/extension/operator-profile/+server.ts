import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth, resolveDeviceOrgId } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import {
  loadOperatorProfile,
  saveOperatorProfile,
  recordVoiceSamples,
} from '@pitchbox/shared/operator-profile';
import { refreshVoiceProfile } from '@pitchbox/shared/operator-voice-profile';

// LI-21 (2026-09-07): the server side of the operator persona capture.
// linkedin-profile-capture.ts reads whatever `/in/<slug>` page the human has
// open and posts it here; this route is what actually decides whether it
// gets kept, since the content script itself cannot tell the operator's own
// profile from one they merely opened to read
// (extension/src/content/shared/linkedin-dom.ts's own doc comment on
// `readOwnProfile` explains why it does not try).
//
// **The persona guard.** If `operator_profiles` has no row yet for this
// organization, the first capture establishes the handle. If it already has
// one with a *different* handle, the capture is refused
// (`refused: 'not_your_profile'`) rather than merged - visiting a
// competitor's profile page must never silently overwrite who the
// companion believes it is writing as. This is a `200`, not a `4xx`: it is
// an expected, frequent outcome (any research visit to someone else's
// profile triggers it), not a client error.
//
// **Text is clamped, not rejected - except the display name, which is also
// checked for shape.** Every free-text field comes straight off a real
// page's DOM, which has no length contract with us - clamping keeps a long
// About section or post from blowing up the companion prompt without
// failing the whole capture over it. `displayName` gets one more check on
// top of that: `readOwnProfile`'s client-side selector scoping
// (extension/src/content/shared/linkedin-dom.ts) is a defense the server
// cannot see past, so a bad extension build or a changed LinkedIn render
// that slips LinkedIn's own UI chrome (a notification-count badge, an
// unread-count title prefix) into this field is caught here instead
// (`refused: 'implausible_name'`, LOR-180) - the same `200`, not `4xx`,
// posture as the persona guard below, since a stale build retrying the
// same bad capture is an expected outcome, not a client error.

const perDevice = new RateLimiter(20, 60_000);

const MAX_HANDLE_LEN = 200;
const MAX_NAME_LEN = 200;
const MAX_HEADLINE_LEN = 300;
const MAX_ABOUT_LEN = 4000;
const MAX_EXPERIENCE_FIELD_LEN = 200;
const MAX_EXPERIENCE_SUMMARY_LEN = 1200;
const MAX_POST_TEXT_LEN = 3000;
const MAX_EXPERIENCES = 20;
const MAX_POSTS = 20;

/** Trims and truncates - used across every free-text field this route
 * accepts (handle, name, headline, about, each experience field, each post
 * body), matching suggest-prompt.ts's own `clamp` for the same reason: a
 * capture off a real page has no length contract with us. */
function clamp(text: string, max: number): string {
  return text.trim().slice(0, max);
}

// A plausible human display name is one to six space-separated words, each
// starting with a letter and built only from letters, marks, apostrophes,
// hyphens and periods - no digits, no LinkedIn's own punctuation. This is
// deliberately structural, not a denylist of known chrome strings: the
// reported failure ("0 notifiche in totale", LinkedIn's own Italian
// notification-count badge) has a leading digit, which is the one thing a
// denylist could never generalise past the next render or locale.
const NAME_SHAPE = /^\p{L}[\p{L}\p{M}'’.-]*(?: \p{L}[\p{L}\p{M}'’.-]*){0,5}$/u;

const ExperienceSchema = z.object({
  title: z.string().optional(),
  company: z.string().optional(),
  period: z.string().optional(),
  summary: z.string().optional(),
});

const PostSchema = z.object({
  externalId: z.string().min(1),
  text: z.string().min(1),
  url: z.string().optional(),
  postedAt: z.string().optional(),
});

const BodySchema = z.object({
  handle: z.string().min(1),
  displayName: z.string().optional(),
  headline: z.string().optional(),
  about: z.string().optional(),
  experiences: z.array(ExperienceSchema).max(MAX_EXPERIENCES).optional(),
  posts: z.array(PostSchema).max(MAX_POSTS).optional(),
  /** Human asked, from Settings, to let a fresh capture replace a
   * hand-edited (`source: 'manual'`) row. The extension itself never sets
   * this. */
  overwrite: z.boolean().optional(),
});

export async function POST({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);
  if (!perDevice.consume(`device:${auth.deviceId}`)) throw error(429, 'too many requests');

  const raw = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid body');
  const body = parsed.data;

  const handle = clamp(body.handle, MAX_HANDLE_LEN);
  if (!handle) throw error(400, 'invalid body');

  const displayName = body.displayName?.trim() ? clamp(body.displayName, MAX_NAME_LEN) : undefined;
  if (displayName !== undefined && !NAME_SHAPE.test(displayName)) {
    return json({ ok: false, refused: 'implausible_name' });
  }

  const db = getDb();
  const orgId = await resolveDeviceOrgId(db, auth.organizationId);
  if (orgId == null) throw error(404, 'not_found');

  const existing = await loadOperatorProfile(db, orgId);
  if (existing?.handle && existing.handle !== handle) {
    return json({ ok: false, refused: 'not_your_profile' });
  }

  const experiences = body.experiences
    ?.map((e) => ({
      title: e.title?.trim() ? clamp(e.title, MAX_EXPERIENCE_FIELD_LEN) : undefined,
      company: e.company?.trim() ? clamp(e.company, MAX_EXPERIENCE_FIELD_LEN) : undefined,
      period: e.period?.trim() ? clamp(e.period, MAX_EXPERIENCE_FIELD_LEN) : undefined,
      summary: e.summary?.trim() ? clamp(e.summary, MAX_EXPERIENCE_SUMMARY_LEN) : undefined,
    }))
    .filter((e) => e.title || e.company || e.summary);

  await saveOperatorProfile(
    db,
    orgId,
    {
      handle,
      displayName,
      headline: body.headline?.trim() ? clamp(body.headline, MAX_HEADLINE_LEN) : undefined,
      about: body.about?.trim() ? clamp(body.about, MAX_ABOUT_LEN) : undefined,
      experiences: experiences?.length ? experiences : undefined,
      source: 'linkedin_capture',
    },
    { overwrite: body.overwrite === true },
  );

  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'))
    .limit(1);

  let voiceSamplesRecorded = 0;
  if (platform && body.posts?.length) {
    voiceSamplesRecorded = await recordVoiceSamples(
      db,
      orgId,
      platform.id,
      body.posts.slice(0, MAX_POSTS).map((p) => ({
        externalId: p.externalId,
        text: clamp(p.text, MAX_POST_TEXT_LEN),
        url: p.url ?? null,
        postedAt: p.postedAt ?? null,
      })),
    );
    // A real new sample changes the corpus the voice profile is derived
    // from (#407) - refresh it here rather than waiting for the human to
    // notice in Settings. A no-op on a `source: 'manual'` row, same
    // protection saveOperatorProfile gives the persona above.
    if (voiceSamplesRecorded > 0) {
      await refreshVoiceProfile(db, orgId);
    }
  }

  return json({ ok: true, voiceSamplesRecorded });
}
