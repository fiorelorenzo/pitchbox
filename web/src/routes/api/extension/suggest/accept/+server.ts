import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth, resolveDeviceOrgId } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import { loadLinkedInAssistDeviceState } from '@pitchbox/shared/linkedin-assist';
import { acceptSuggestion } from '@pitchbox/shared/assist-accept';
import { billingPeriodFor } from '@pitchbox/shared/org-quota';
import { getOrgUsage } from '@pitchbox/shared/usage';
import { isOrgReadOnly } from '@pitchbox/shared/plans';
import { resolveDefaultRunnerSlug } from '@pitchbox/shared/agents/config';

// The other half of the real-time plane (#313): `POST /api/extension/suggest`
// produces text nobody has committed to anything yet; this endpoint is what
// turns the human's accept - the suggestion plus whatever they edited - into
// a row in the assist plane's own ledger, through the same blocklist/dedup
// gates a campaign draft goes through (`shared/src/assist-accept.ts`). No
// `drafts` row, no `runs` row (#521) - see docs/linkedin-integration-design.md,
// "Bookkeeping, which is where the two planes touch."
//
// There is no suggestion registry to reference by id - `/suggest` writes
// nothing down - so the accept body carries the full context the panel
// already holds in memory: the post, the kind, the final text and the usage
// block `/suggest`'s `done` event reported.

// Same shape as /suggest's own limiter: an accept is one human decision per
// suggestion, so it is rarer than a suggestion request, but sized the same to
// avoid a second magic number.
const perDevice = new RateLimiter(20, 60_000);
const perOrg = new RateLimiter(60, 60_000);

const BodySchema = z.object({
  // #523: context only - a suggestion can be accepted with no project at
  // all, and files under none when it is.
  projectId: z.number().int().positive().optional(),
  kind: z.enum(['post_comment', 'post']),
  post: z.object({
    urn: z.string().max(200).optional(),
    authorHandle: z.string().max(200).optional(),
    authorName: z.string().max(200).optional(),
    url: z.string().max(2000).optional(),
  }),
  body: z.string().min(1).max(10000),
  // #521: the model's own draft text, sent only when the human changed it
  // before accepting - worth keeping on the ledger row, per that issue's
  // own field list.
  editedFrom: z.string().max(10000).optional(),
  platform: z.string().min(1).max(40).default('linkedin'),
  usage: z
    .object({
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
      cacheReadTokens: z.number().nonnegative().optional(),
      cacheCreationTokens: z.number().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  ms: z.number().nonnegative().optional(),
});

export async function POST(event: RequestEvent) {
  const auth = await requireExtensionAuth(event.request);

  if (!perDevice.consume(`device:${auth.deviceId}`)) throw error(429, 'too many accepts');
  if (auth.organizationId != null && !perOrg.consume(`org:${auth.organizationId}`)) {
    throw error(429, 'too many accepts for this organization');
  }

  const parsed = BodySchema.safeParse(await event.request.json());
  if (!parsed.success) throw error(400, parsed.error.issues[0]?.message ?? 'invalid body');
  const body = parsed.data;

  const db = getDb();

  const orgId = await resolveDeviceOrgId(db, auth.organizationId);
  if (orgId == null) throw error(404, 'organization not found');

  // Org scoping, same posture as /suggest and /observations: an id that
  // doesn't resolve for this org 404s rather than 403s, leaking nothing
  // about other tenants' ids. #523: a request naming no project skips this
  // entirely rather than resolving one.
  const project =
    body.projectId != null
      ? (
          await db
            .select()
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.id, body.projectId),
                eq(schema.projects.organizationId, orgId),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
  if (body.projectId != null && !project) throw error(404, 'project not found');

  // #554: a failed payment past its grace window refuses an accept the same
  // way it refuses the suggestion that preceded it - a suggestion nobody can
  // request cannot legitimately be committed to the ledger either.
  const period = await billingPeriodFor(db, orgId);
  const usage = await getOrgUsage(db, orgId, period);
  if (isOrgReadOnly(usage.entitlements)) {
    return json({ refused: 'plan_payment_required' });
  }

  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, body.platform))
    .limit(1);
  if (!platform) throw error(400, `unknown platform: ${body.platform}`);

  // The assist gate (#359's enforcement pattern, applied here too): an org
  // whose assistant is off or whose kill switch is engaged must be refused
  // just as firmly as a suggestion is - a suggestion that cannot be
  // produced but can still be accepted is a hole in the same switch.
  // Scoped to `linkedin` for the same reason /suggest scopes it:
  // `linkedin_assist` is a LinkedIn-only setting. LOR-181: no longer checks
  // `body.projectId` against a bound project - there is no such binding
  // left to check. An old extension build that still sends the project it
  // used to bind to is ignored exactly like /suggest already ignores it:
  // `body.projectId` above is validated only against this org's own
  // projects (never trusted for anything past that), and travels onto the
  // ledger as context alone.
  if (platform.slug === 'linkedin') {
    const assist = await loadLinkedInAssistDeviceState(db, orgId);
    if (!assist.enabled) {
      return json({
        refused: assist.killSwitch ? 'kill_switch' : 'assist_disabled',
        platform: platform.slug,
      });
    }
  }

  // Unlike the campaign commenter playbook (targetUser always null - "the
  // audience is whoever reads the post, not one person"), the assist accept
  // path knows exactly which member's post the human is engaging in real
  // time, so a `post_comment` carries that author as its target: it is what
  // lets the blocklist and contact-history ledger see it at all (#336). A
  // `post` has no target - it is the human's own content, merely inspired by
  // something they read. Unaffected by whether the post had a URN: the
  // target is the author, not the post's identifier.
  const authorHandle =
    body.kind === 'post_comment' && body.post.authorHandle ? body.post.authorHandle : null;

  const result = await acceptSuggestion(db, {
    organizationId: orgId,
    projectId: project?.id ?? null,
    platformId: platform.id,
    kind: body.kind,
    authorHandle,
    authorName: body.post.authorName ?? null,
    postUrn: body.post.urn ?? null,
    postUrl: body.post.url ?? null,
    body: body.body,
    editedFrom: body.editedFrom ?? null,
    deviceId: auth.deviceId,
    agentRunner: project?.defaultAgentRunner ?? (await resolveDefaultRunnerSlug(db)),
    usage: body.usage ?? null,
  });

  if (!result.ok) {
    const { reason, ...rest } = result.refusal;
    return json({ refused: reason, ...rest });
  }

  return json({ ok: true, id: result.id, dedupWarning: result.dedupWarning });
}
