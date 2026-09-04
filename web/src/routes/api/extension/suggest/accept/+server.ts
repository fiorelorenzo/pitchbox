import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import { emit } from '$lib/server/events.js';
import { loadLinkedInAssistDeviceState } from '@pitchbox/shared/linkedin-assist';
import { acceptSuggestionIntoDraft } from '@pitchbox/shared/assist-accept';

// The other half of the real-time plane (#313): `POST /api/extension/suggest`
// produces text nobody has committed to anything yet; this endpoint is what
// turns the human's accept - the suggestion plus whatever they edited - into
// a real `drafts` row, through the same blocklist/dedup/quota gates a
// campaign draft goes through (`shared/src/assist-accept.ts`). See
// docs/linkedin-integration-design.md, "Bookkeeping, which is where the two
// planes touch."
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
  projectId: z.number().int().positive(),
  kind: z.enum(['post_comment', 'post']),
  post: z.object({
    urn: z.string().max(200).optional(),
    authorHandle: z.string().max(200).optional(),
    authorName: z.string().max(200).optional(),
    url: z.string().max(2000).optional(),
  }),
  body: z.string().min(1).max(10000),
  platform: z.string().min(1).max(40).default('linkedin'),
  usage: z
    .object({
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
      cacheReadTokens: z.number().nonnegative().optional(),
      cacheCreationTokens: z.number().nonnegative().optional(),
      costUsd: z.number().nullable().optional(),
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

  // Org scoping, same posture as /suggest and /observations: an id that
  // doesn't resolve for this org 404s rather than 403s, leaking nothing
  // about other tenants' ids.
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(
      auth.organizationId == null
        ? eq(schema.projects.id, body.projectId)
        : and(
            eq(schema.projects.id, body.projectId),
            eq(schema.projects.organizationId, auth.organizationId),
          ),
    )
    .limit(1);
  if (!project) throw error(404, 'project not found');

  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, body.platform))
    .limit(1);
  if (!platform) throw error(400, `unknown platform: ${body.platform}`);

  // The assist gate (#359's enforcement pattern, applied here too): an org
  // whose assistant is off, whose kill switch is engaged, or that names a
  // project other than the bound one must be refused just as firmly as a
  // suggestion is - a suggestion that cannot be produced but can still be
  // accepted is a hole in the same switch. Scoped to `linkedin` for the same
  // reason /suggest scopes it: `linkedin_assist` is a LinkedIn-only setting.
  if (platform.slug === 'linkedin') {
    const assist = await loadLinkedInAssistDeviceState(db, project.organizationId);
    if (!assist.enabled) {
      return json({
        refused: assist.killSwitch ? 'kill_switch' : 'assist_disabled',
        platform: platform.slug,
      });
    }
    if (assist.projectId !== project.id) {
      return json({
        refused: 'project_not_bound',
        platform: platform.slug,
        boundProjectId: assist.projectId,
      });
    }
  }

  // Convention shared with the linkedin-commenter playbook (sourceRef holds
  // the post's own identifiers; see playbooks/linkedin-commenter.md).
  const sourceRef: Record<string, unknown> = {};
  if (body.post.urn) sourceRef.externalId = body.post.urn;
  if (body.post.url) sourceRef.url = body.post.url;

  // Unlike the campaign commenter playbook (targetUser always null - "the
  // audience is whoever reads the post, not one person"), the assist accept
  // path knows exactly which member's post the human is engaging in real
  // time, so a `post_comment` carries that author as its target: it is what
  // lets the blocklist and contact-history ledger see it at all. A `post`
  // has no target - it is the human's own content, merely inspired by
  // something they read.
  const targetUser =
    body.kind === 'post_comment' && body.post.authorHandle ? body.post.authorHandle : null;

  const result = await acceptSuggestionIntoDraft(db, {
    projectId: project.id,
    organizationId: project.organizationId,
    platformId: platform.id,
    kind: body.kind,
    targetUser,
    body: body.body,
    sourceRef,
    metadata: {
      ...(body.post.authorHandle ? { authorHandle: body.post.authorHandle } : {}),
      ...(body.post.authorName ? { authorName: body.post.authorName } : {}),
    },
    agentRunner: project.defaultAgentRunner,
    usage: body.usage ?? null,
    runParams: { suggestionKind: body.kind, ms: body.ms ?? null },
  });

  if (!result.ok) {
    const { reason, ...rest } = result.refusal;
    return json({ refused: reason, ...rest });
  }

  emit('drafts:changed', { id: result.draftId, state: 'pending_review' }, project.organizationId);

  return json({ ok: true, draftId: result.draftId, runId: result.runId });
}
