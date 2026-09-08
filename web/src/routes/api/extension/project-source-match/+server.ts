import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireExtensionAuth, resolveDeviceOrgId } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import {
  findPendingProjectSourceMatch,
  fillProjectSourceFromCapture,
} from '@pitchbox/shared/project-source-match';

// Plane 3 (#436, spike #435): fills a project's pending `linkedin_post`/
// `linkedin_profile` source from the human's own navigation, next to
// POST /api/extension/observations' own precedent - the same device bearer
// auth, the same org scoping, the same "read only what already rendered"
// posture. Two calls, on purpose, mirroring linkedin-observe.ts's own
// assist-state poll before it collects anything: a small GET first asks
// whether the page the content script just landed on
// (linkedin-source-capture.ts) matches ANY pending source in this org at
// all, before anything is read from the DOM; only a real match triggers the
// second call, POSTing what the page actually showed. A page with nothing
// pending never has its content sent anywhere.
//
// `linkedin_company` is a real `PROJECT_SOURCE_KINDS` value but not
// reachable here: nothing creates a `linkedin_company` row with an
// `identifier` in its config
// (`web/src/routes/api/projects/[id]/sources/+server.ts` deliberately
// excludes it from `ADDABLE_KINDS` - #436 shipped `linkedin_post`/
// `linkedin_profile` only, company needs new selector work spike #435
// explicitly deferred), so GET never matches one and POST never fills one.

const MatchKind = z.enum(['linkedin_post', 'linkedin_profile']);

// A human navigating LinkedIn can land on several matching pages a minute;
// looser than /suggest's perDevice(20, 60_000) for the same reason
// observations' own limiter is, tighter than observations' 30 since this is
// one small read per page load rather than a debounced batch.
const perDeviceGet = new RateLimiter(40, 60_000);
const perDevicePost = new RateLimiter(20, 60_000);

export async function GET({ request, url }: { request: Request; url: URL }) {
  const auth = await requireExtensionAuth(request);
  if (!perDeviceGet.consume(`device:${auth.deviceId}`)) throw error(429, 'too many requests');

  const kindParsed = MatchKind.safeParse(url.searchParams.get('kind'));
  const identifier = url.searchParams.get('identifier');
  if (!kindParsed.success || !identifier) throw error(400, 'invalid query');

  const db = getDb();
  const orgId = await resolveDeviceOrgId(db, auth.organizationId);
  if (orgId == null) throw error(404, 'not_found');

  const match = await findPendingProjectSourceMatch(db, orgId, kindParsed.data, identifier);
  return json({ match: match ? { sourceId: match.id } : null });
}

// Free text off a real page has no length contract with us - clamped, not
// rejected, matching operator-profile.ts's own posture for the same reason.
const MAX_NAME_LEN = 200;
const MAX_HANDLE_LEN = 200;
const MAX_HEADLINE_LEN = 300;
const MAX_ABOUT_LEN = 4000;
const MAX_TEXT_LEN = 3000;
const MAX_URL_LEN = 2048;
const MAX_EXPERIENCES = 20;
const MAX_EXPERIENCE_FIELD_LEN = 200;
const MAX_EXPERIENCE_SUMMARY_LEN = 1200;

function clamp(text: string, max: number): string {
  return text.trim().slice(0, max);
}

function clampedOrNull(text: string | null | undefined, max: number): string | null {
  return text?.trim() ? clamp(text, max) : null;
}

const ExperienceSchema = z.object({
  title: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  period: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
});

const PostOutputSchema = z.object({
  urn: z.string().min(1),
  authorName: z.string().nullable().optional(),
  authorHandle: z.string().nullable().optional(),
  text: z.string().min(1),
  url: z.string().optional(),
  capturedAt: z.string().optional(),
});

const ProfileOutputSchema = z.object({
  handle: z.string().min(1),
  displayName: z.string().nullable().optional(),
  headline: z.string().nullable().optional(),
  about: z.string().nullable().optional(),
  experiences: z.array(ExperienceSchema).max(MAX_EXPERIENCES).optional(),
  url: z.string().optional(),
  capturedAt: z.string().optional(),
});

const PostBody = z.discriminatedUnion('kind', [
  z.object({
    sourceId: z.number().int().positive(),
    kind: z.literal('linkedin_post'),
    identifier: z.string().min(1).max(2048),
    output: PostOutputSchema,
  }),
  z.object({
    sourceId: z.number().int().positive(),
    kind: z.literal('linkedin_profile'),
    identifier: z.string().min(1).max(2048),
    output: ProfileOutputSchema,
  }),
]);

function clampPostOutput(o: z.infer<typeof PostOutputSchema>) {
  return {
    urn: clamp(o.urn, MAX_HANDLE_LEN),
    authorName: clampedOrNull(o.authorName, MAX_NAME_LEN),
    authorHandle: clampedOrNull(o.authorHandle, MAX_HANDLE_LEN),
    text: clamp(o.text, MAX_TEXT_LEN),
    url: clampedOrNull(o.url, MAX_URL_LEN),
    capturedAt: o.capturedAt ?? new Date().toISOString(),
  };
}

function clampProfileOutput(o: z.infer<typeof ProfileOutputSchema>) {
  return {
    handle: clamp(o.handle, MAX_HANDLE_LEN),
    displayName: clampedOrNull(o.displayName, MAX_NAME_LEN),
    headline: clampedOrNull(o.headline, MAX_HEADLINE_LEN),
    about: clampedOrNull(o.about, MAX_ABOUT_LEN),
    experiences: (o.experiences ?? []).slice(0, MAX_EXPERIENCES).map((e) => ({
      title: clampedOrNull(e.title, MAX_EXPERIENCE_FIELD_LEN),
      company: clampedOrNull(e.company, MAX_EXPERIENCE_FIELD_LEN),
      period: clampedOrNull(e.period, MAX_EXPERIENCE_FIELD_LEN),
      summary: clampedOrNull(e.summary, MAX_EXPERIENCE_SUMMARY_LEN),
    })),
    url: clampedOrNull(o.url, MAX_URL_LEN),
    capturedAt: o.capturedAt ?? new Date().toISOString(),
  };
}

// Never throws for a stale/mismatched fill attempt - the two calls are not
// atomic, so a source deleted, refreshed back to pending, or already filled
// by another tab in between is an expected outcome, not a client error,
// mirroring `refreshGithubSource`'s "never throw for a fetch that didn't
// land" contract.
export async function POST({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);
  if (!perDevicePost.consume(`device:${auth.deviceId}`)) throw error(429, 'too many requests');

  const raw = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid body');
  const body = parsed.data;

  const db = getDb();
  const orgId = await resolveDeviceOrgId(db, auth.organizationId);
  if (orgId == null) throw error(404, 'not_found');

  const output =
    body.kind === 'linkedin_post' ? clampPostOutput(body.output) : clampProfileOutput(body.output);

  const source = await fillProjectSourceFromCapture(
    db,
    orgId,
    body.sourceId,
    body.kind,
    body.identifier,
    output,
  );
  if (!source) return json({ ok: false });
  return json({ ok: true, source });
}
