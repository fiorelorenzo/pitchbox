// shared/src/assist/tools.ts (#567)
//
// The seven tools the in-page assistant's agent loop may call
// (docs/design/in-page-agent.md, "What the agent may know and do"): declared
// once here, executed server-side, and driven by two transports that share
// these exact handler functions - native tools on `SdkRunner`
// (`shared/src/agents/sdk/`) and the assist MCP entry point
// (`cli/src/mcp/assist-server.ts`) for the ACP path. #566 owns wiring the
// loop that calls these; this file owns what each tool is allowed to know
// and refuse.
//
// Every tool takes its authority from `AssistToolContext`, never from a
// model-supplied argument: the org id, the observed target and the operator
// persona are all resolved server-side before the loop ever starts.
// `project_knowledge`'s `projectId` is the one argument a tool trusts from
// the model, and it is validated against the caller's own organization
// rather than trusted outright (see its handler below) - an org id accepted
// from the model would be a cross-tenant hole one hallucination wide. Since
// LOR-181 (2026-09-10) there is no longer a single project "the suggestion
// is filed under" to also check it against: the model is free to look up
// any of the organization's own projects while it is still deciding which
// one (if any) this suggestion is about.
//
// A tool that has nothing to say returns `{ ok: false, reason }` - an
// explicit nothing, never `{ ok: true, data: <empty> }` - because "no prior
// contact with this person" is information a suggestion needs, and an empty
// result only teaches the model to retry. `check_style` is the one
// exception: it is deterministic and never refuses, so a clean draft
// legitimately gets back an empty findings list.
//
// No tool writes anything. Not a draft, not an observation, not a run row -
// the accept path stays the single place the assist plane touches durable
// state (#520/#521).

import { z } from 'zod';
import { and, desc, eq, ilike, isNotNull, or, type Column, type SQL } from 'drizzle-orm';
import { generateText } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { schema, type Db } from '../db/client.js';
import { isBlocklisted } from '../blocklist.js';
import { loadVoiceProfile } from '../operator-voice-profile.js';
import { resolveEntitlements } from '../plans.js';
import { resolveFunctionModel, gateModelForPlan } from '../ai/model-functions.js';
import { loadGatewayCatalogue } from '../ai/gateway-catalogue.js';
import { buildSdkUsage, type SdkModelPricing } from '../agents/sdk/event-normalizer.js';
import { checkStyle, type StyleFinding } from '../style-check.js';
import {
  MAX_COMMENT_CHARS,
  MAX_POST_CHARS,
  MAX_THREAD_CHARS,
  MAX_THREAD_COMMENTS,
  VOICE_PROFILE_MAX,
  type ObservedPost,
} from './suggest-prompt.js';
import type { OperatorPersona } from './context.js';
import { MIN_ITEMS_TO_DERIVE } from './voice-profile.js';

// ---------------------------------------------------------------------------
// The observed target and its image, and the context every handler reads.
// ---------------------------------------------------------------------------

/**
 * The image crop captured with the observed target (#569). Declared locally
 * rather than as a change to `ObservedPost` in this file: #569 lands the
 * real field (`ObservedPost.image?: ObservedImage`) on its own branch in
 * parallel, and this shape is structurally identical to what was agreed
 * with that issue over `hub` - once it lands, `ObservedPost & { image?:
 * ObservedImage }` below is simply redundant with the base type, never in
 * conflict with it.
 */
export interface ObservedImage {
  /** `data:<mediaType>;base64,<...>` of the downscaled, capped crop.
   * Absent when the post has media but no pixels reached the server (not
   * visible on screen, capture permission not granted). */
  dataUrl?: string;
  /** LinkedIn's own alt text, present independently of `dataUrl`. */
  alt?: string;
  kind: 'image' | 'video_frame' | 'carousel_page' | 'document_page';
  /** True for one page of a multi-page carousel or document post - the
   * description must not overclaim it is the whole post. */
  partial?: boolean;
}

/** What `read_thread` and `look_at_image` read: the post `runSuggestion`
 * already grounded before the loop starts (the request body for a
 * `post_comment`, or the DB-loaded recent observation for a `post` - see
 * `web/src/lib/server/suggest.ts`'s `groundedPost`), plus the image crop. */
export type AssistObservedTarget = ObservedPost & { image?: ObservedImage };

export interface AssistToolContext {
  db: Db;
  /** The organization this suggestion belongs to. Every query below filters
   * on this - never on anything a tool argument could name. */
  orgId: number;
  /** Null when nothing was captured for this device (a fresh binding, nothing
   * scrolled since the collector was last on) - every tool that reads it
   * refuses explicitly rather than fabricating a post. */
  observedTarget: AssistObservedTarget | null;
  /** The operator's own persona, loaded once by the caller
   * (`assist/context.ts`'s `loadCompanionContext`) so `operator_voice`
   * never re-queries `operator_profiles` itself. */
  operator: OperatorPersona | null;
}

/** A tool's answer is either real data or an explicit refusal - never an
 * empty success, per the module header. */
export type AssistToolAnswer<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface AssistTool<TArgs = Record<string, never>, TResult = unknown> {
  name: string;
  description: string;
  /** A zod raw shape (not `z.object(...)`), so the same declaration wraps
   * as-is into both `tool({ inputSchema: z.object(shape) })` for the SDK
   * path and `registerTool({ inputSchema: shape })` for the assist MCP
   * server. */
  schema: z.ZodRawShape;
  /** `signal` is provided by the loop's cancellation wrapper (#566) and is
   * optional so the six DB-backed tools can ignore it; `look_at_image` is
   * the one handler that threads it into a real network call, so a
   * cancelled suggestion actually stops paying for it rather than merely
   * being ignored by the caller. */
  handler: (
    ctx: AssistToolContext,
    args: TArgs,
    signal?: AbortSignal,
  ) => Promise<AssistToolAnswer<TResult>>;
}

// ---------------------------------------------------------------------------
// Shared clamping. Every payload below is bounded the same way the prompt
// builder already bounds one (suggest-prompt.ts's own `clamp`), and every
// clamp is marked on the result rather than applied silently.
// ---------------------------------------------------------------------------

function clampText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

async function resolveLinkedinPlatformId(db: Db): Promise<number | null> {
  const [row] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'))
    .limit(1);
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// read_thread
// ---------------------------------------------------------------------------

export interface ReadThreadResult {
  post: {
    author: { handle?: string; name?: string };
    text: string;
    url?: string;
    relativeTime?: string;
    reactionCount?: string;
    commentCount?: string;
  };
  comments: Array<{
    id?: string;
    author: { handle?: string; name?: string };
    body: string;
    relativeTime?: string;
    parentId?: string;
  }>;
  /** How many comment articles the page actually rendered, per
   * `ObservedThread.renderedCount` - can run ahead of `comments.length`
   * once either cap below bites. */
  renderedCommentCount: number;
  clamp: { textTruncated: boolean; commentsTruncated: boolean };
}

const readThread: AssistTool<Record<string, never>, ReadThreadResult> = {
  name: 'read_thread',
  description:
    "The post plus the visible comment thread the human's own browser had rendered for this suggestion: author, text, comment bodies with their authors, relative times and parent relationships. Read this before writing anything specific, so the suggestion says something the thread does not already say.",
  schema: {},
  async handler(ctx) {
    const post = ctx.observedTarget;
    if (!post) {
      return {
        ok: false,
        reason: 'no thread was captured for this device - nothing rendered to read',
      };
    }
    const { text, truncated: textTruncated } = clampText(post.text ?? '', MAX_POST_CHARS);

    const rawComments = post.thread?.comments ?? [];
    const cappedComments = rawComments.slice(0, MAX_THREAD_COMMENTS);
    const comments: ReadThreadResult['comments'] = [];
    let usedChars = 0;
    let charsCapped = false;
    for (const c of cappedComments) {
      const { text: body } = clampText(c.body ?? '', MAX_COMMENT_CHARS);
      if (usedChars + body.length > MAX_THREAD_CHARS) {
        charsCapped = true;
        break;
      }
      usedChars += body.length;
      comments.push({
        id: c.id,
        author: { handle: c.authorHandle, name: c.authorName },
        body,
        relativeTime: c.relativeTime,
        parentId: c.parentId,
      });
    }

    return {
      ok: true,
      data: {
        post: {
          author: { handle: post.authorHandle, name: post.authorName },
          text,
          url: post.url,
          relativeTime: post.relativeTime,
          reactionCount: post.reactionCount,
          commentCount: post.commentCount,
        },
        comments,
        renderedCommentCount: post.thread?.renderedCount ?? comments.length,
        clamp: {
          textTruncated,
          commentsTruncated:
            charsCapped || comments.length < rawComments.length || !!post.thread?.truncated,
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// look_at_image
// ---------------------------------------------------------------------------

const LOOK_AT_IMAGE_DESCRIPTION_MAX = 800;
const VISION_DESCRIPTION_MARKER = 'DESCRIPTION:';
const VISION_TEXT_MARKER = 'TEXT_IN_IMAGE:';

export interface LookAtImageResult {
  description: string;
  /** Text found inside the image, verbatim; null when there was none. */
  textInImage: string | null;
  source: 'vision' | 'alt_text';
  kind: ObservedImage['kind'];
  partial: boolean;
  /** Present only when a real vision call ran - the only tool whose result
   * carries a spend the loop's total usage has to fold in (design doc,
   * "look_at_image is a real model call and the only tool that spends
   * tokens"). `costUsd` is priced here, not left for the loop to guess at:
   * the loop only knows this call happened by reading `tool-result`, has no
   * way to know which model answered it, and `resolveFunctionModel`/
   * `gateModelForPlan` above already resolved that model in this handler -
   * pricing it anywhere else would mean re-resolving the same model a
   * second time or threading it back out through the tool's answer shape
   * for no reason (#574). */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    /** Null when the catalogue has no pricing for the resolved model -
     * never a guess (`pricingFromCatalogueEntry`'s own rule, mirrored here
     * via the lighter shared catalogue, `shared/src/ai/gateway-catalogue.ts`). */
    costUsd?: number | null;
  };
  clamp: { descriptionTruncated: boolean };
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const match = /^data:([-\w.]+\/[-\w.+]+);base64,(.+)$/su.exec(dataUrl.trim());
  if (!match) return null;
  return { mediaType: match[1], base64: match[2] };
}

function imageKindLabel(kind: ObservedImage['kind'], partial: boolean | undefined): string {
  const base =
    kind === 'video_frame'
      ? 'a single frame of a video'
      : kind === 'carousel_page'
        ? 'one page of a carousel'
        : kind === 'document_page'
          ? 'one page of a document'
          : 'an image';
  return partial
    ? `${base} (only one part of a multi-part post - do not describe it as the whole post)`
    : base;
}

/** Extracts the description and any in-image text from the vision model's
 * reply. A non-compliant reply (no markers) falls back to the raw text as
 * the description rather than losing it - the same worst-case-is-never-
 * blank posture `style-check.ts`'s `extractRewrite` and `envelope.ts`
 * already follow. */
function splitVisionResponse(raw: string): { description: string; textInImage: string | null } {
  const descIdx = raw.indexOf(VISION_DESCRIPTION_MARKER);
  const textIdx = raw.indexOf(VISION_TEXT_MARKER);
  if (descIdx === -1 || textIdx === -1 || textIdx < descIdx) {
    const fallback = raw.trim();
    return { description: fallback || 'the model returned no description', textInImage: null };
  }
  const description = raw.slice(descIdx + VISION_DESCRIPTION_MARKER.length, textIdx).trim();
  const textPart = raw.slice(textIdx + VISION_TEXT_MARKER.length).trim();
  const textInImage = textPart.length === 0 || /^none$/iu.test(textPart) ? null : textPart;
  return { description: description || 'the model returned no description', textInImage };
}

const lookAtImage: AssistTool<Record<string, never>, LookAtImageResult> = {
  name: 'look_at_image',
  description:
    'Looks at the crop of the post\u2019s image, chart or slide that the extension captured from the rendered tab, and returns a short description plus any text found in it. Never fetches a remote asset - the pixels are only ever what the human\u2019s own browser already rendered. Skip this tool entirely on a text-only post.',
  schema: {},
  async handler(ctx, _args, signal) {
    const image = ctx.observedTarget?.image;
    if (!image) {
      return { ok: false, reason: 'this post has no image - nothing to look at' };
    }
    if (!image.dataUrl && !image.alt) {
      return {
        ok: false,
        reason:
          'there is an image on this post that could not be captured (not visible on screen, or capture unavailable) - do not guess or invent what it shows',
      };
    }
    if (!image.dataUrl) {
      const { text, truncated } = clampText(image.alt!, LOOK_AT_IMAGE_DESCRIPTION_MAX);
      return {
        ok: true,
        data: {
          description: text,
          textInImage: null,
          source: 'alt_text',
          kind: image.kind,
          partial: image.partial ?? false,
          clamp: { descriptionTruncated: truncated },
        },
      };
    }

    // No provider API key on a self-host running the ACP backend (the
    // design doc's "authentication model" argument, section 1) - this one
    // tool degrades to an explicit nothing rather than failing the whole
    // loop, the same posture as every other refusal here.
    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        reason:
          'vision is not available on this deployment (no Gateway key configured) - describe only what the post text says',
      };
    }
    const parsed = parseDataUrl(image.dataUrl);
    if (!parsed) {
      return { ok: false, reason: 'the captured image could not be decoded' };
    }

    try {
      const modelId = await resolveFunctionModel(ctx.db, 'assist_vision');
      const entitlements = await resolveEntitlements(ctx.db, ctx.orgId);
      const gatedModelId = await gateModelForPlan(
        'assist_vision',
        modelId,
        entitlements.premiumModels,
      );
      const gateway = createGateway({ apiKey });

      const result = await generateText({
        model: gateway(gatedModelId),
        abortSignal: signal,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `Describe ${imageKindLabel(image.kind, image.partial)} from a LinkedIn post in two or three ` +
                  'sentences - only the image itself, not the post text around it. Then transcribe any text ' +
                  'visible inside the image verbatim, or say "none" if there is none. Answer in exactly this ' +
                  `shape, nothing before or after it:\n${VISION_DESCRIPTION_MARKER} <two or three sentences>\n` +
                  `${VISION_TEXT_MARKER} <verbatim text, or none>`,
              },
              { type: 'file', mediaType: parsed.mediaType, data: parsed.base64 },
            ],
          },
        ],
      });

      // Priced from the same shared, process-wide-cached catalogue
      // `gateModelForPlan` (via `isPremiumModel`) already warmed a few
      // lines up for the same `gatedModelId` - no second Gateway round
      // trip in the common case (#574).
      const catalogue = await loadGatewayCatalogue();
      const priced = catalogue.models.find((m) => m.id === gatedModelId);
      const pricing: SdkModelPricing | undefined =
        priced?.inputPerToken != null && priced.outputPerToken != null
          ? {
              inputPerToken: priced.inputPerToken,
              outputPerToken: priced.outputPerToken,
              // The lighter shared catalogue carries no cache-discount
              // fields - one vision call rarely repeats a cached prefix
              // anyway, so this falls back to the plain input rate, the
              // same direction `pricingFromCatalogueEntry` already takes
              // for a provider that reports no discount.
              cachedInputPerToken: priced.inputPerToken,
              cacheCreationPerToken: priced.inputPerToken,
            }
          : undefined;
      const priceUsage = buildSdkUsage(result.usage, { pricing });

      const { description, textInImage } = splitVisionResponse(result.text);
      const { text: clampedDescription, truncated } = clampText(
        description,
        LOOK_AT_IMAGE_DESCRIPTION_MAX,
      );
      return {
        ok: true,
        data: {
          description: clampedDescription,
          textInImage,
          source: 'vision',
          kind: image.kind,
          partial: image.partial ?? false,
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens,
            cacheCreationTokens: result.usage.inputTokenDetails?.cacheWriteTokens,
            costUsd: priceUsage.costUsd,
          },
          clamp: { descriptionTruncated: truncated },
        },
      };
    } catch (err) {
      // A slow or failing vision provider must not fail the whole
      // suggestion (design doc, "a partial suggestion beats an error") -
      // it degrades to the same explicit nothing as every other refusal.
      return {
        ok: false,
        reason: `the vision call failed or timed out (${err instanceof Error ? err.message : String(err)}) - describe only what the post text says`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// author_history
// ---------------------------------------------------------------------------

const AUTHOR_HISTORY_MAX_ITEMS = 5;
const AUTHOR_HISTORY_EXCERPT_MAX = 300;

export interface AuthorHistoryResult {
  handle: string;
  blocked: boolean;
  blockedReason: string | null;
  contactedBefore: boolean;
  lastContactedAt: string | null;
  repliedAt: string | null;
  uncontactable: boolean;
  uncontactableReason: string | null;
  priorOutreach: Array<{
    id: number;
    kind: string;
    state: string;
    /** True for a row from the assist plane's own ledger
     * (`assist_accepted_suggestions`, #521) rather than a campaign draft. */
    viaAssist: boolean;
    excerpt: string;
    createdAt: string;
  }>;
  priorMessages: Array<{ id: number; isFromUs: boolean; excerpt: string; at: string }>;
  clamp: { outreachTruncated: boolean; messagesTruncated: boolean };
}

const authorHistory: AssistTool<Record<string, never>, AuthorHistoryResult> = {
  name: 'author_history',
  description:
    "What this organization already knows about the post's author: contact history, prior drafts and sent messages, prior accepted suggestions, and whether they are blocklisted. Prevents greeting somebody as a stranger after three exchanges, and pitching somebody who asked not to be pitched.",
  schema: {},
  async handler(ctx) {
    const authorHandle = ctx.observedTarget?.authorHandle?.trim();
    if (!authorHandle) {
      return { ok: false, reason: 'the captured post has no author handle to look up' };
    }
    const platformId = await resolveLinkedinPlatformId(ctx.db);
    if (platformId == null) {
      return { ok: false, reason: 'the linkedin platform is not configured on this instance' };
    }

    const [blocklistResult, contactRows, draftRows, acceptedRows, messageRows] = await Promise.all([
      // No project id: nothing is bound before the model decides one, so
      // this only ever sees the organization's global blocklist entries -
      // a project-scoped block only takes effect once the accept path
      // resolves a real project for this suggestion (`assist-accept.ts`),
      // the same enforce-where-the-effect-happens posture the rest of the
      // plane follows.
      isBlocklisted(ctx.db, {
        platformId,
        projectId: null,
        targetUser: authorHandle,
      }),
      ctx.db
        .select({
          lastContactedAt: schema.contactHistory.lastContactedAt,
          repliedAt: schema.contactHistory.repliedAt,
          uncontactable: schema.contactHistory.uncontactable,
          uncontactableReason: schema.contactHistory.uncontactableReason,
        })
        .from(schema.contactHistory)
        .where(
          and(
            eq(schema.contactHistory.organizationId, ctx.orgId),
            eq(schema.contactHistory.platformId, platformId),
            eq(schema.contactHistory.targetUser, authorHandle),
          ),
        )
        .orderBy(desc(schema.contactHistory.lastContactedAt))
        .limit(1),
      // Campaign drafts only, going forward: an accepted suggestion never
      // writes a `runs`/`drafts` row again (#521) - its own prior outreach
      // comes from `assistAcceptedSuggestions` below instead.
      ctx.db
        .select({
          id: schema.drafts.id,
          kind: schema.drafts.kind,
          state: schema.drafts.state,
          body: schema.drafts.body,
          sentContent: schema.drafts.sentContent,
          createdAt: schema.drafts.createdAt,
        })
        .from(schema.drafts)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
        .where(
          and(
            eq(schema.projects.organizationId, ctx.orgId),
            eq(schema.drafts.platformId, platformId),
            eq(schema.drafts.targetUser, authorHandle),
          ),
        )
        .orderBy(desc(schema.drafts.createdAt))
        .limit(AUTHOR_HISTORY_MAX_ITEMS),
      ctx.db
        .select({
          id: schema.assistAcceptedSuggestions.id,
          kind: schema.assistAcceptedSuggestions.kind,
          body: schema.assistAcceptedSuggestions.body,
          createdAt: schema.assistAcceptedSuggestions.createdAt,
        })
        .from(schema.assistAcceptedSuggestions)
        .where(
          and(
            eq(schema.assistAcceptedSuggestions.organizationId, ctx.orgId),
            eq(schema.assistAcceptedSuggestions.platformId, platformId),
            eq(schema.assistAcceptedSuggestions.authorHandle, authorHandle),
          ),
        )
        .orderBy(desc(schema.assistAcceptedSuggestions.createdAt))
        .limit(AUTHOR_HISTORY_MAX_ITEMS),
      ctx.db
        .select({
          id: schema.messages.id,
          isFromUs: schema.messages.isFromUs,
          body: schema.messages.body,
          createdAtPlatform: schema.messages.createdAtPlatform,
        })
        .from(schema.messages)
        .innerJoin(schema.contactHistory, eq(schema.contactHistory.id, schema.messages.contactId))
        .where(
          and(
            eq(schema.contactHistory.organizationId, ctx.orgId),
            eq(schema.contactHistory.platformId, platformId),
            eq(schema.contactHistory.targetUser, authorHandle),
          ),
        )
        .orderBy(desc(schema.messages.createdAtPlatform))
        .limit(AUTHOR_HISTORY_MAX_ITEMS),
    ]);

    const contact = contactRows[0] ?? null;
    const hasAnySignal =
      blocklistResult.blocked ||
      !!contact ||
      draftRows.length > 0 ||
      acceptedRows.length > 0 ||
      messageRows.length > 0;
    if (!hasAnySignal) {
      return {
        ok: false,
        reason: `no prior contact with ${authorHandle} - nothing on file for this organization`,
      };
    }

    // Two sources of prior outreach, merged by time: campaign drafts and the
    // assist plane's own ledger (#521) - an accepted suggestion has no state
    // machine to report, so it reports the fixed state 'accepted' instead.
    const outreach = [
      ...draftRows.map((d) => ({
        id: d.id,
        kind: d.kind,
        state: d.state,
        viaAssist: false,
        excerpt: clampText(d.sentContent ?? d.body, AUTHOR_HISTORY_EXCERPT_MAX).text,
        createdAt: d.createdAt,
      })),
      ...acceptedRows.map((a) => ({
        id: a.id,
        kind: a.kind,
        state: 'accepted',
        viaAssist: true,
        excerpt: clampText(a.body, AUTHOR_HISTORY_EXCERPT_MAX).text,
        createdAt: a.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const outreachTruncated =
      draftRows.length >= AUTHOR_HISTORY_MAX_ITEMS ||
      acceptedRows.length >= AUTHOR_HISTORY_MAX_ITEMS ||
      outreach.length > AUTHOR_HISTORY_MAX_ITEMS;

    return {
      ok: true,
      data: {
        handle: authorHandle,
        blocked: blocklistResult.blocked,
        blockedReason: blocklistResult.reason,
        contactedBefore: !!contact,
        lastContactedAt: contact?.lastContactedAt?.toISOString() ?? null,
        repliedAt: contact?.repliedAt?.toISOString() ?? null,
        uncontactable: contact?.uncontactable ?? false,
        uncontactableReason: contact?.uncontactableReason ?? null,
        priorOutreach: outreach.slice(0, AUTHOR_HISTORY_MAX_ITEMS).map((o) => ({
          id: o.id,
          kind: o.kind,
          state: o.state,
          viaAssist: o.viaAssist,
          excerpt: o.excerpt,
          createdAt: o.createdAt.toISOString(),
        })),
        priorMessages: messageRows.map((m) => ({
          id: m.id,
          isFromUs: m.isFromUs,
          excerpt: clampText(m.body, AUTHOR_HISTORY_EXCERPT_MAX).text,
          at: m.createdAtPlatform.toISOString(),
        })),
        clamp: {
          outreachTruncated,
          messagesTruncated: messageRows.length >= AUTHOR_HISTORY_MAX_ITEMS,
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// operator_voice
// ---------------------------------------------------------------------------

/** Mirrors `suggest-prompt.ts`'s private `PERSONA_ABOUT_MAX` (also 1200) -
 * not exported there, so restated here rather than reached across a module
 * boundary that does not expose it. */
const OPERATOR_ABOUT_MAX = 1200;

const DEFAULT_VOICE_NOTE =
  'No measured voice on file yet for this organization - too few voice samples, sent messages or drafts to say anything honest about how this person writes. Write in a clear, direct, first-person register without presuming a habit that has not been observed.';

export interface OperatorVoiceResult {
  persona: {
    displayName: string | null;
    headline: string | null;
    about: string | null;
    notes: string | null;
  } | null;
  voice: {
    status: 'measured' | 'default';
    summary: string;
    itemCount: number;
    derivedAt: string | null;
  };
  clamp: { aboutTruncated: boolean; summaryTruncated: boolean };
}

const operatorVoice: AssistTool<Record<string, never>, OperatorVoiceResult> = {
  name: 'operator_voice',
  description:
    "The operator's own persona and derived writing voice for this organization: who is typing, and how they actually write when they have written enough for that to mean anything. Never invents a voice from a thin corpus - a thin corpus gets an honest default instead.",
  schema: {},
  async handler(ctx) {
    const voiceRow = await loadVoiceProfile(ctx.db, ctx.orgId);
    const measured =
      !!voiceRow && voiceRow.itemCount >= MIN_ITEMS_TO_DERIVE && voiceRow.summary.trim().length > 0;
    const persona = ctx.operator;
    const about = persona?.about ? clampText(persona.about, OPERATOR_ABOUT_MAX) : null;
    const summary = measured ? clampText(voiceRow!.summary, VOICE_PROFILE_MAX) : null;

    return {
      ok: true,
      data: {
        persona: persona
          ? {
              displayName: persona.displayName ?? null,
              headline: persona.headline ?? null,
              about: about?.text ?? null,
              notes: persona.notes ?? null,
            }
          : null,
        voice: {
          status: measured ? 'measured' : 'default',
          summary: measured ? summary!.text : DEFAULT_VOICE_NOTE,
          itemCount: voiceRow?.itemCount ?? 0,
          derivedAt: voiceRow?.derivedAt?.toISOString() ?? null,
        },
        clamp: {
          aboutTruncated: about?.truncated ?? false,
          summaryTruncated: summary?.truncated ?? false,
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// project_knowledge
// ---------------------------------------------------------------------------

const PROJECT_KNOWLEDGE_REPOS_MAX = 4;
const PROJECT_KNOWLEDGE_README_MAX = 400;
const PROJECT_KNOWLEDGE_DESCRIPTION_MAX = 800;
const PROJECT_KNOWLEDGE_INSIGHTS_MAX = 2;
const PROJECT_KNOWLEDGE_INSIGHT_CHARS = 1200;

export interface ProjectKnowledgeResult {
  project: { id: number; name: string; description: string | null };
  repos: Array<{
    owner: string;
    repo: string;
    url: string;
    description: string | null;
    primaryLanguage: string | null;
    readmeExcerpt: string | null;
    recentCommits: Array<{ message: string; committedAt?: string | null }>;
  }>;
  insights: Array<{ summary: string; generatedAt: string }>;
  clamp: { descriptionTruncated: boolean; reposTruncated: boolean; insightsTruncated: boolean };
}

const projectKnowledge: AssistTool<{ projectId: number }, ProjectKnowledgeResult> = {
  name: 'project_knowledge',
  description:
    "One of the organization's projects, by id - its brief, the organization's public repos and their recent commits, and that project's own insights. Fetch this for a project listed above when its brief alone is not enough to tell whether the post is actually about it, or once you have decided it is and want more to draft from. The id is checked against this organization only, never trusted otherwise.",
  schema: { projectId: z.number().int().positive() },
  async handler(ctx, args) {
    const [projectRow] = await ctx.db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        description: schema.projects.description,
      })
      .from(schema.projects)
      .where(
        and(eq(schema.projects.id, args.projectId), eq(schema.projects.organizationId, ctx.orgId)),
      )
      .limit(1);
    if (!projectRow) {
      return { ok: false, reason: `project ${args.projectId} does not exist in this organization` };
    }

    const [repoRows, insightRows] = await Promise.all([
      ctx.db
        .select()
        .from(schema.githubSources)
        .where(
          and(
            eq(schema.githubSources.organizationId, ctx.orgId),
            eq(schema.githubSources.active, true),
          ),
        )
        .orderBy(desc(schema.githubSources.fetchedAt))
        .limit(PROJECT_KNOWLEDGE_REPOS_MAX),
      ctx.db
        .select({
          summaryMd: schema.projectInsights.summaryMd,
          generatedAt: schema.projectInsights.generatedAt,
        })
        .from(schema.projectInsights)
        .where(eq(schema.projectInsights.projectId, args.projectId))
        .orderBy(desc(schema.projectInsights.generatedAt))
        .limit(PROJECT_KNOWLEDGE_INSIGHTS_MAX),
    ]);

    const repos = repoRows
      .filter((r) => r.readmeExcerpt || r.description || (r.recentCommits as unknown[])?.length)
      .map((r) => ({
        owner: r.owner,
        repo: r.repo,
        url: r.url,
        description: r.description,
        primaryLanguage: r.primaryLanguage,
        readmeExcerpt: r.readmeExcerpt
          ? clampText(r.readmeExcerpt, PROJECT_KNOWLEDGE_README_MAX).text
          : null,
        recentCommits:
          (r.recentCommits as Array<{ message: string; committedAt?: string | null }>) ?? [],
      }));
    const insights = insightRows.map((i) => ({
      summary: clampText(i.summaryMd, PROJECT_KNOWLEDGE_INSIGHT_CHARS).text,
      generatedAt: i.generatedAt.toISOString(),
    }));
    const description = projectRow.description
      ? clampText(projectRow.description, PROJECT_KNOWLEDGE_DESCRIPTION_MAX)
      : null;

    if (!description && repos.length === 0 && insights.length === 0) {
      return {
        ok: false,
        reason: `project "${projectRow.name}" has no description, repos or insights on file yet`,
      };
    }

    return {
      ok: true,
      data: {
        project: {
          id: projectRow.id,
          name: projectRow.name,
          description: description?.text ?? null,
        },
        repos,
        insights,
        clamp: {
          descriptionTruncated: description?.truncated ?? false,
          reposTruncated: repoRows.length >= PROJECT_KNOWLEDGE_REPOS_MAX,
          insightsTruncated: insightRows.length >= PROJECT_KNOWLEDGE_INSIGHTS_MAX,
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// my_prior_takes
// ---------------------------------------------------------------------------

const PRIOR_TAKES_MAX_MATCHES = 5;
const PRIOR_TAKES_EXCERPT_MAX = 400;
const PRIOR_TAKES_MAX_WORDS = 6;

// A short stopword list, English and Italian - the same split
// `assist/voice-profile.ts`'s own STOPWORDS carries, for the same reason:
// Lorenzo's feed is half Italian. Only used to keep a lexical match from
// firing on grammar rather than subject matter; it does not need to be
// exhaustive.
const PRIOR_TAKES_STOPWORDS: Record<string, true> = {
  the: true, and: true, for: true, with: true, that: true, this: true, have: true, from: true, about: true, your: true, you: true,
  are: true, was: true, were: true, been: true, they: true, their: true, what: true, when: true, where: true, which: true,
  into: true, over: true, than: true, then: true, also: true, just: true, like: true, more: true, some: true,
  della: true, delle: true, degli: true, questo: true, questa: true, queste: true, questi: true, anche: true, come: true,
  sono: true, stato: true, stati: true, state: true, perche: true, quando: true, dove: true, quale: true, quali: true,
}; // prettier-ignore

function significantWords(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    if (word.length < 4 || PRIOR_TAKES_STOPWORDS[word] || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= PRIOR_TAKES_MAX_WORDS) break;
  }
  return out;
}

function wordMatchClause(column: Column, words: string[]): SQL {
  return or(...words.map((w) => ilike(column, `%${w}%`)))!;
}

export type PriorTakeSource = 'voice_sample' | 'message' | 'sent_draft' | 'template';

export interface MyPriorTakesResult {
  matches: Array<{ source: PriorTakeSource; excerpt: string; at: string | null }>;
  clamp: { truncatedToTop: boolean };
}

const myPriorTakes: AssistTool<{ query: string }, MyPriorTakesResult> = {
  name: 'my_prior_takes',
  description:
    "What the operator has already written on a subject - their own voice samples, sent messages, sent drafts and project templates, matched lexically against the query - so a suggestion does not repeat a line used last week. Pass the post's own subject, not the whole post text.",
  schema: { query: z.string().min(1).max(300) },
  async handler(ctx, args) {
    const words = significantWords(args.query);
    if (words.length === 0) {
      return { ok: false, reason: 'no searchable words in that query' };
    }

    const [sampleRows, messageRows, draftRows, templateRows] = await Promise.all([
      ctx.db
        .select({
          text: schema.operatorVoiceSamples.text,
          at: schema.operatorVoiceSamples.capturedAt,
        })
        .from(schema.operatorVoiceSamples)
        .where(
          and(
            eq(schema.operatorVoiceSamples.organizationId, ctx.orgId),
            eq(schema.operatorVoiceSamples.excluded, false),
            wordMatchClause(schema.operatorVoiceSamples.text, words),
          ),
        )
        .orderBy(desc(schema.operatorVoiceSamples.capturedAt))
        .limit(PRIOR_TAKES_MAX_MATCHES),
      ctx.db
        .select({ text: schema.messages.body, at: schema.messages.createdAtPlatform })
        .from(schema.messages)
        .innerJoin(schema.contactHistory, eq(schema.contactHistory.id, schema.messages.contactId))
        .where(
          and(
            eq(schema.contactHistory.organizationId, ctx.orgId),
            eq(schema.messages.isFromUs, true),
            wordMatchClause(schema.messages.body, words),
          ),
        )
        .orderBy(desc(schema.messages.createdAtPlatform))
        .limit(PRIOR_TAKES_MAX_MATCHES),
      ctx.db
        .select({
          body: schema.drafts.body,
          sentContent: schema.drafts.sentContent,
          at: schema.drafts.sentAt,
        })
        .from(schema.drafts)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
        .where(
          and(
            eq(schema.projects.organizationId, ctx.orgId),
            isNotNull(schema.drafts.sentAt),
            wordMatchClause(schema.drafts.body, words),
          ),
        )
        .orderBy(desc(schema.drafts.sentAt))
        .limit(PRIOR_TAKES_MAX_MATCHES),
      ctx.db
        .select({ text: schema.templates.body, at: schema.templates.updatedAt })
        .from(schema.templates)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.templates.projectId))
        .where(
          and(
            eq(schema.projects.organizationId, ctx.orgId),
            wordMatchClause(schema.templates.body, words),
          ),
        )
        .orderBy(desc(schema.templates.updatedAt))
        .limit(PRIOR_TAKES_MAX_MATCHES),
    ]);

    const matches = [
      ...sampleRows.map((r) => ({
        source: 'voice_sample' as const,
        excerpt: clampText(r.text, PRIOR_TAKES_EXCERPT_MAX).text,
        at: r.at?.toISOString() ?? null,
      })),
      ...messageRows.map((r) => ({
        source: 'message' as const,
        excerpt: clampText(r.text, PRIOR_TAKES_EXCERPT_MAX).text,
        at: r.at?.toISOString() ?? null,
      })),
      ...draftRows.map((r) => ({
        source: 'sent_draft' as const,
        excerpt: clampText(r.sentContent ?? r.body, PRIOR_TAKES_EXCERPT_MAX).text,
        at: r.at?.toISOString() ?? null,
      })),
      ...templateRows.map((r) => ({
        source: 'template' as const,
        excerpt: clampText(r.text, PRIOR_TAKES_EXCERPT_MAX).text,
        at: r.at?.toISOString() ?? null,
      })),
    ]
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, PRIOR_TAKES_MAX_MATCHES);

    if (matches.length === 0) {
      return { ok: false, reason: `no prior writing on file matches "${args.query}"` };
    }
    const totalFound =
      sampleRows.length + messageRows.length + draftRows.length + templateRows.length;
    return { ok: true, data: { matches, clamp: { truncatedToTop: totalFound > matches.length } } };
  },
};

// ---------------------------------------------------------------------------
// check_style
// ---------------------------------------------------------------------------

export interface CheckStyleResult {
  findings: StyleFinding[];
}

const checkStyleTool: AssistTool<{ text: string }, CheckStyleResult> = {
  name: 'check_style',
  description:
    'Runs the deterministic house-style checker against a draft and returns every finding - a banned character, a filler opener, a tricolon, a LinkedIn tell - so the model can fix its own tells before answering. Never refuses (an empty findings list is a real, clean answer). Not a substitute for the server-side enforcement that runs on every draft regardless.',
  schema: { text: z.string().min(1).max(20_000) },
  async handler(_ctx, args) {
    return { ok: true, data: { findings: checkStyle(args.text) } };
  },
};

// ---------------------------------------------------------------------------
// The seven tools.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ASSIST_TOOLS: Array<AssistTool<any, any>> = [
  readThread,
  lookAtImage,
  authorHistory,
  operatorVoice,
  projectKnowledge,
  myPriorTakes,
  checkStyleTool,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ASSIST_TOOLS_BY_NAME: Record<string, AssistTool<any, any>> = Object.fromEntries(
  ASSIST_TOOLS.map((t) => [t.name, t]),
);
