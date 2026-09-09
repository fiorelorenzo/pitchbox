import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth, resolveDeviceOrgId } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import { runSuggestion } from '$lib/server/suggest.js';
import { loadActiveTemplates } from '@pitchbox/shared/templates';
import { resolveDefaultRunnerSlug } from '@pitchbox/shared/agents/config';
import {
  MAX_COMMENT_CHARS,
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_POST_CHARS,
  MAX_THREAD_CHARS,
  MAX_THREAD_COMMENTS,
  RETUNE_DIRECTIONS,
  type ObservedPost,
  type SuggestionKind,
} from '@pitchbox/shared/assist/suggest-prompt';
import { loadCompanionContext } from '@pitchbox/shared/assist/context';
import {
  loadLinkedInAssistDeviceState,
  resolveEffectiveVoice,
} from '@pitchbox/shared/linkedin-assist';
import { loadRecentObservedTarget } from '@pitchbox/shared/observed-targets';
import { billingPeriodFor } from '@pitchbox/shared/org-quota';
import { getOrgUsage } from '@pitchbox/shared/usage';
import { checkUsageThresholds } from '@pitchbox/shared/usage-notifications';
import { isOrgReadOnly } from '@pitchbox/shared/plans';

// The real-time plane. What makes the in-page assistant a separate subsystem
// rather than a view onto campaigns:
//
//   - No `runs` row and no draft. A suggestion is ephemeral until the human
//     accepts it, and #313 owns what happens then. Mixing the two planes here
//     is the mistake the design exists to avoid.
//   - No playbook and no MCP server. One prompt, one turn, streamed out.
//   - The API is the enforcement boundary, not the panel: auth, org scoping,
//     rate limit and quota are all decided here.

// Per device. A human reads a suggestion before asking for another, so this is
// generous for real use and still bounds what a stolen token can spend.
const perDevice = new RateLimiter(20, 60_000);
// Per org, so one compromised device cannot spend a whole tenant's budget and
// several legitimate devices still add up to something sane.
const perOrg = new RateLimiter(60, 60_000);

// #568: one comment/reply in the visible thread, capped per-body by
// MAX_COMMENT_CHARS. The aggregate MAX_THREAD_CHARS cap (across every
// comment's body combined) cannot be expressed as a single field
// constraint, so it is checked in the `superRefine` below instead.
const CommentSchema = z.object({
  id: z.string().max(200).optional(),
  authorName: z.string().max(200).optional(),
  authorHandle: z.string().max(200).optional(),
  body: z.string().max(MAX_COMMENT_CHARS),
  relativeTime: z.string().max(200).optional(),
  parentId: z.string().max(200).optional(),
});

const ThreadSchema = z.object({
  comments: z.array(CommentSchema).max(MAX_THREAD_COMMENTS),
  renderedCount: z.number().int().min(0),
  truncated: z.boolean(),
});

// #569: the post's attached media, captured as pixels from the human's own
// rendered tab - see docs/design/in-page-agent.md's "capture the rendered
// tab, never fetch licdn" rule and `ObservedImage`'s own doc comment for
// what each combination of present/absent fields means. `dataUrl` is
// re-capped here rather than trusted from the extension's own clamp, same
// posture as every other field on this schema.
const ImageSchema = z.object({
  dataUrl: z
    .string()
    .max(MAX_IMAGE_DATA_URL_CHARS)
    .regex(
      /^data:image\/(jpeg|png|webp);base64,/,
      'post.image.dataUrl must be a base64 image data URL',
    )
    .optional(),
  alt: z.string().max(1000).optional(),
  kind: z.enum(['image', 'video_frame', 'carousel_page']),
  partial: z.boolean().optional(),
});

const BodySchema = z
  .object({
    projectId: z.number().int().positive().optional(),
    kind: z.enum(['post_comment', 'post']),
    post: z.object({
      urn: z.string().max(200).optional(),
      authorHandle: z.string().max(200).optional(),
      authorName: z.string().max(200).optional(),
      text: z
        .string()
        .max(MAX_POST_CHARS * 2)
        .optional(),
      url: z.string().max(2000).optional(),
      // #568: what the page cheaply says about the room, plus the visible
      // thread itself - all classic-post-detail-only and all optional, the
      // same posture as every other post field above.
      relativeTime: z.string().max(200).optional(),
      reactionCount: z.string().max(100).optional(),
      commentCount: z.string().max(100).optional(),
      thread: ThreadSchema.optional(),
      // #569: the post's attached media - see ImageSchema's own doc comment
      // for what each combination of present/absent sub-fields means.
      image: ImageSchema.optional(),
    }),
    hint: z.string().max(500).optional(),
    // #409: a panel-level retune direction, never a setting - see the
    // comment on `assistSettings` below for why this is the one field on
    // this plane the request may legitimately carry.
    retune: z.enum(RETUNE_DIRECTIONS).optional(),
    // #576: a live session id from a prior `done` event, so a retune or a
    // hint-on-a-regenerate continues that turn's gathered context instead
    // of starting over. Never trusted blind - `runSuggestion` re-checks it
    // against this request's own org/project/kind and falls back to a full
    // rebuild on anything that doesn't match or has expired.
    sessionId: z.string().max(200).optional(),
    platform: z.string().min(1).max(40).default('linkedin'),
  })
  .superRefine((val, ctx) => {
    // A `post_comment` suggestion is grounded in the post the panel read off
    // the page - that travels with the request, there is nothing else to
    // draft from. A `post` suggestion is grounded server-side instead (see
    // the observed-targets read below, #315): the composer itself has no
    // post to riff off, so its own `post` is informational at most and may
    // be empty.
    if (val.kind === 'post_comment' && !val.post.text?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'post.text is required for kind "post_comment"',
        path: ['post', 'text'],
      });
    }
    // #568: the one thread cap `z.array().max()`/`z.string().max()` above
    // cannot express - the combined body length across every comment,
    // rather than any single one. The schema is the enforcement boundary
    // (AGENTS.md), so this rejects rather than silently re-truncating what
    // the extension already clamped.
    const thread = val.post.thread;
    if (thread) {
      const totalChars = thread.comments.reduce((sum, c) => sum + c.body.length, 0);
      if (totalChars > MAX_THREAD_CHARS) {
        ctx.addIssue({
          code: 'custom',
          message: `post.thread.comments combined body length exceeds ${MAX_THREAD_CHARS}`,
          path: ['post', 'thread', 'comments'],
        });
      }
    }
  });

function sse(controller: ReadableStreamDefaultController, encoder: TextEncoder) {
  return (kind: string, data: unknown) => {
    controller.enqueue(encoder.encode(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`));
  };
}

export async function POST(event: RequestEvent) {
  const auth = await requireExtensionAuth(event.request);

  // Both limiters are consumed before any await that could interleave, which is
  // what makes a synchronous check-and-increment safe (see rate-limit.ts).
  if (!perDevice.consume(`device:${auth.deviceId}`)) throw error(429, 'too many suggestions');
  if (auth.organizationId != null && !perOrg.consume(`org:${auth.organizationId}`)) {
    throw error(429, 'too many suggestions for this organization');
  }

  const parsed = BodySchema.safeParse(await event.request.json());
  if (!parsed.success) throw error(400, parsed.error.issues[0]?.message ?? 'invalid body');
  const body = parsed.data;

  const db = getDb();

  // Org scoping: a device bound to an org may only write as one of its own
  // projects, and an unknown project is a 404 rather than a 403 so it leaks
  // nothing about other tenants' ids. A null-org device (self-host, auth
  // off) is unrestricted, mirroring requireRole. #523: `projectId` is
  // optional context now, not a requirement - a request naming none
  // resolves the org directly rather than through a project row.
  const orgId = await resolveDeviceOrgId(db, auth.organizationId);
  if (orgId == null) throw error(404, 'organization not found');

  const project =
    body.projectId != null
      ? (
          await db
            .select()
            .from(schema.projects)
            .where(and(eq(schema.projects.id, body.projectId), eq(schema.projects.organizationId, orgId)))
            .limit(1)
        )[0]
      : undefined;
  if (body.projectId != null && !project) throw error(404, 'project not found');

  const period = await billingPeriodFor(db, orgId);
  const usage = await getOrgUsage(db, orgId, period);
  // #557: a courtesy notification never blocks a suggestion, admitted or
  // refused by the checks below.
  try {
    await checkUsageThresholds(db, orgId, usage, period);
  } catch (err) {
    console.error('[extension/suggest] checkUsageThresholds failed:', err);
  }
  // #554: a failed payment past its grace window refuses before the plan's
  // own suggestions ceiling below, same renderable-200 shape, distinct code
  // so the panel (#556) can render "fix your payment" rather than "upgrade".
  if (isOrgReadOnly(usage.entitlements)) {
    return json({ refused: 'plan_payment_required', upgradeUrl: '/settings/billing' });
  }
  // #548: the plan's own suggestions-per-period ceiling. Read before the
  // platform daily quota below so a plan refusal never pays for a wasted
  // query, and returned in the same renderable-200 shape as every other
  // refusal on this route (self-host resolves fully unlimited, so this
  // never fires there).
  if (usage.suggestions.limit != null && usage.suggestions.used >= usage.suggestions.limit) {
    return json({
      refused: 'plan_limit_reached',
      metric: 'suggestions',
      limit: usage.suggestions.limit,
      used: usage.suggestions.used,
      upgradeUrl: '/settings/billing',
    });
  }

  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, body.platform))
    .limit(1);
  if (!platform) throw error(400, `unknown platform: ${body.platform}`);

  // #521: the per-account draft quota this used to precondition against
  // (`accounts`, `mapDraftKindToQuotaKind`, `checkQuota`) is retired - it
  // was a proxy for what a campaign draft's own send-time check does, and
  // an accepted suggestion no longer becomes a draft at all. What bounds
  // this route now is the per-device/per-org rate limiter above and the
  // plan's own suggestions ceiling just checked.

  // The kill switch has to be enforced here, not only honoured by the panel
  // (#316 shipped the switch and the device read path; nothing refused a call
  // that ignored them). This route's own header says the API is the
  // enforcement boundary and not the panel, and a switch a client can decline
  // to read is not a switch: a stolen device token, a stale content script or
  // a tab left open across the flip all reach this code with the org's
  // assistant explicitly turned off.
  //
  // Scoped to the platform the switch actually names. `linkedin_assist` is a
  // LinkedIn setting, so gating every platform on it would silently block a
  // future Mastodon or Reddit assist that nobody ever wired to it.
  if (platform.slug === 'linkedin') {
    const assist = await loadLinkedInAssistDeviceState(db, orgId);
    if (!assist.enabled) {
      // Same posture as the quota refusal above: a 200 with a body the panel
      // can render. Nothing went wrong, an admin turned it off.
      return json({
        refused: assist.killSwitch ? 'kill_switch' : 'assist_disabled',
        platform: platform.slug,
      });
    }
    // A suggestion naming a project is written as that project's voice, so
    // naming a different project of the same org than the one bound is not
    // a narrower case of the binding, it bypasses it (#523: naming none at
    // all is not a bypass - it makes no binding claim, and is always
    // allowed).
    if (body.projectId != null && assist.projectId !== body.projectId) {
      return json({
        refused: 'project_not_bound',
        platform: platform.slug,
        boundProjectId: assist.projectId,
      });
    }
  }

  // A `post` suggestion has no post to riff off the way a `post_comment`
  // does - the composer is a blank box - so it is grounded in the most
  // recent thing the observation buffer (#301/#302) actually saw this
  // project's account scroll past, read through the server rather than
  // trusting the panel to have scraped and forwarded a pile of observed
  // posts itself. That buffer is project-scoped (`observed_targets`), so
  // unlike `post_comment`, a `post` suggestion still needs a real project
  // to draft from (#523 makes the project optional for the plane overall,
  // not for this one kind that has nothing else to ground itself in). An
  // empty buffer (a fresh binding, or nothing sighted since the collector
  // was last on) is a real, distinct refusal: there is nothing honest to
  // write a "starting point" prompt from, so this refuses the same way an
  // exhausted quota does rather than asking the model to invent a subject.
  let groundedPost: ObservedPost;
  if (body.kind === 'post') {
    if (!project) {
      return json({ refused: 'project_required', platform: platform.slug });
    }
    const recent = await loadRecentObservedTarget(db, {
      organizationId: orgId,
      projectId: project.id,
      platformId: platform.id,
    });
    if (!recent) {
      return json({ refused: 'no_recent_activity', platform: platform.slug });
    }
    groundedPost = {
      authorHandle: recent.authorHandle ?? undefined,
      authorName: recent.authorName ?? undefined,
      text: recent.text,
      url: recent.url,
    };
  } else {
    // superRefine above guarantees a non-empty post.text for this branch.
    groundedPost = { ...body.post, text: body.post.text as string };
  }

  // #578: id and createdAt travel too, not just title/body -
  // `buildSuggestionPrompt` (`shared/src/assist/example-selection.ts`) picks
  // which of these actually reach the prompt, by topical closeness to
  // `groundedPost` rather than by this array's order. No project, no
  // templates to draw from.
  const examples = project
    ? (
        await loadActiveTemplates(db, {
          projectId: project.id,
          kind: body.kind === 'post' ? 'post' : 'comment',
        })
      ).map((t) => ({ id: t.id, title: t.title, body: t.body, createdAt: t.createdAt }))
    : [];

  // Everything the companion is allowed to know beyond this one post:
  // the operator's own persona and voice, every project in the org, and the
  // public repos GitHub read cached (shared/src/assist/context.ts). Loaded
  // once, right before the spawn, so a refusal above never pays for it.
  const context = await loadCompanionContext(db, {
    organizationId: orgId,
    currentProjectId: project?.id ?? null,
  });

  // The tone (#405) is read here, resolved against the project this
  // suggestion is actually being filed under (#408) - never from `body`: the
  // panel is not an enforcement boundary for it, exactly as it is not for
  // `enabled`, `killSwitch` or the reasoning/draft split. That is also what
  // keeps a panel-level retune (#409) an explicit feature rather than
  // something a crafted request already gets for free. `project` here is
  // the filed-under project, which need not be the org's bound project the
  // device state names, and may be absent entirely (#523) - the org's own
  // `linkedin_assist` tone is what an unset project falls back to.
  const voice = await resolveEffectiveVoice(
    db,
    orgId,
    project ?? { voiceTone: null, voiceToneNotes: null },
  );
  // No project bound, no `defaultAgentRunner` column to read - the instance
  // (or edition) default is what a fresh project would have gotten anyway.
  const runnerSlug = project?.defaultAgentRunner ?? (await resolveDefaultRunnerSlug(db));

  let cancel: () => void = () => {};
  let settled = false;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = sse(controller, encoder);

      // Padding first: Chrome buffers a small event-stream body until it has
      // enough of it, which would hide exactly the early chunks this endpoint
      // exists to deliver.
      controller.enqueue(encoder.encode(': ' + ' '.repeat(2048) + '\n\n'));
      send('status', { phase: 'reading' });

      // The panel is not the enforcement boundary for the reasoning/draft
      // split either (#382): `runSuggestion` already ran every chunk through
      // `EnvelopeSplitter`, so this callback only routes what it is handed,
      // and "writing" fires on the first DRAFT-section text specifically -
      // not the first chunk of any kind, which used to be reasoning.
      let wroteDraft = false;
      const handle = runSuggestion({
        kind: body.kind as SuggestionKind,
        post: groundedPost,
        currentProject: project ? { name: project.name, description: project.description } : null,
        persona: context.persona,
        voiceProfile: context.voiceProfile,
        projects: context.projects,
        repos: context.repos,
        examples,
        hint: body.hint,
        retune: body.retune,
        tone: voice.tone,
        toneNotes: voice.toneNotes,
        projectId: project?.id ?? null,
        orgId: auth.organizationId ?? undefined,
        runnerSlug,
        continueSessionId: body.sessionId,
        // #573: the tool name(s) the loop is running, comma-joined - the
        // panel translates each into the operator's own words and collapses
        // several into one line. Sent only before the draft starts: once
        // `writing` has fired the step narration is over regardless of what
        // the model does with a tool afterward (`check_style` included).
        onToolStep: (toolNames) => {
          if (!wroteDraft) send('status', { phase: toolNames.join(',') });
        },
        onSlow: () => {
          if (!wroteDraft) send('status', { phase: 'slow' });
        },
        onChunk: (chunk) => {
          if (chunk.reasoning) send('chunk', { text: chunk.reasoning, section: 'reasoning' });
          if (chunk.draft) {
            if (!wroteDraft) {
              wroteDraft = true;
              send('status', { phase: 'writing' });
            }
            send('chunk', { text: chunk.draft, section: 'draft' });
          }
        },
      });
      cancel = handle.cancel;

      handle.result
        .then(async (res) => {
          if (settled) return;
          settled = true;

          // #522: ledgered the moment the suggestion finishes, not only if
          // a human later accepts it - see the header comment on this
          // route and shared/src/org-quota.ts's getOrgMonthToDateCostUsd.
          // A ledger write failing must never keep the human from getting
          // their answer, so it's caught and logged rather than left to
          // reject this handler (which would also skip 'done' below).
          await db
            .insert(schema.assistUsage)
            .values({
              organizationId: auth.organizationId,
              projectId: project?.id ?? null,
              deviceId: auth.deviceId,
              platformId: platform.id,
              kind: body.kind,
              agentRunner: runnerSlug,
              model: res.model ?? null,
              inputTokens: res.usage?.inputTokens ?? null,
              outputTokens: res.usage?.outputTokens ?? null,
              cacheReadTokens: res.usage?.cacheReadTokens ?? null,
              cacheCreationTokens: res.usage?.cacheCreationTokens ?? null,
              costUsd: res.usage?.costUsd != null ? res.usage.costUsd.toFixed(4) : null,
            })
            .catch((err: unknown) => {
              console.error('failed to record assist usage:', err);
            });

          try {
            send('done', {
              reasoning: res.reasoning,
              draft: res.draft,
              skipped: res.skipped,
              usage: res.usage,
              ms: res.ms,
              // #576: the panel hands this back on the next retune/hint so
              // the loop continues instead of starting over. Absent when no
              // tool set was attached or the run never settled into one.
              sessionId: res.sessionId,
              // #573: a genuine early stop with a draft already in hand -
              // the panel says it answered with what it had rather than
              // treating this as an ordinary, deliberate finish.
              budgetExhausted: res.budgetExhausted,
            });
            controller.close();
          } catch (err) {
            // The panel disconnected while the usage write above was in
            // flight - the suggestion is already ledgered, there's simply
            // nobody left to deliver it to.
            console.error('failed to deliver done event:', err);
          }
        })
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          send('failed', { message: err instanceof Error ? err.message : String(err) });
          controller.close();
        });
    },
    cancel() {
      // The human scrolled away or closed the panel. Cancelling here is the
      // difference between a stream nobody reads and a model call nobody pays
      // for; without it the agent process runs to completion unobserved.
      settled = true;
      cancel();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
