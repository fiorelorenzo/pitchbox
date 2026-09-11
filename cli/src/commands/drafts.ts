import { Command } from 'commander';
import { z } from 'zod';
import { getDb, schema, type Db } from '@pitchbox/shared/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  isBlocklisted,
  isSubredditBlocklisted,
  isKeywordBlocklisted,
} from '@pitchbox/shared/blocklist';
import { groupVariants } from '@pitchbox/shared/draft-variants';
import {
  checkContactDedup,
  checkUncontactable,
  parseDedupPolicy,
  DEFAULT_DEDUP_POLICY,
} from '@pitchbox/shared/contact-dedup';
import {
  commentTargetSpec,
  indexCandidateAuthors,
  resolveCommentTargetUser,
} from '@pitchbox/shared/comment-target';
import { notify } from '@pitchbox/shared/notifications';
import { getProjectOrgId } from '@pitchbox/shared/orgs';
import {
  loadQualityRubric,
  resolveOperatorCorpusProfile,
  scoreDraftQuality,
} from '@pitchbox/shared/quality-judge';
import { checkStyle, enforceHouseStyle, type StyleFinding } from '@pitchbox/shared/style-check';
import { buildRedditComposeUrl } from '@pitchbox/shared/platforms/reddit';
import { buildHackernewsComposeUrl } from '@pitchbox/shared/platforms/hackernews';
import { buildMastodonComposeUrl } from '@pitchbox/shared/platforms/mastodon';
import type { DraftKind } from '@pitchbox/shared/quota-types';
import {
  MAX_POST_CHARS,
  MAX_THREAD_COMMENTS,
  MAX_COMMENT_CHARS,
  MAX_THREAD_CHARS,
} from '@pitchbox/shared/assist/suggest-prompt';
import { ok, fail } from '../lib/output.js';

// The compose URL is built here, server-side, from fields the caller already
// supplies (platform, target, subject, body) rather than accepted as agent
// input (issue #325): an agent-supplied URL and `body` are two independent
// arguments with nothing enforcing that the URL's prefilled text is the body
// a human reviews in the Inbox. Each platform owns its own URL shape
// (shared/src/platforms/*/compose-url.ts); this only routes by slug.
function buildComposeUrl(
  platformSlug: string | null,
  input: {
    kind: DraftKind;
    targetUser: string | null;
    subreddit: string | null;
    title: string | null;
    body: string;
    subject: string | null;
    instanceUrl: string | null;
    sourceRef: Record<string, unknown>;
    metadata: Record<string, unknown>;
  },
): string | null {
  switch (platformSlug) {
    case 'reddit':
      return buildRedditComposeUrl(input);
    case 'hackernews':
      return buildHackernewsComposeUrl(input);
    case 'mastodon':
      return buildMastodonComposeUrl(input);
    default:
      return null;
  }
}

/** Pulls `campaign.config.offer.subject` out of jsonb config, if present. The
 * Reddit DM compose URL is the only consumer (issue #325); other scenarios
 * either have no subject field or build their compose URL from the body
 * alone. */
function extractOfferSubject(config: unknown): string | null {
  if (config == null || typeof config !== 'object') return null;
  const offer = (config as Record<string, unknown>).offer;
  if (offer == null || typeof offer !== 'object') return null;
  const subject = (offer as Record<string, unknown>).subject;
  return typeof subject === 'string' && subject.trim() !== '' ? subject : null;
}

/** Word count the same simple way every other length axis in this codebase
 * does (voice-metrics.ts's own scorer, suggest-prompt.ts's `wordCount`) -
 * split on whitespace, drop empties. Reused below for both a draft's own
 * clamped source comments and a reply thread's messages. */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * `sourceRef.sourceText` (the post/story/status this draft answers) and
 * `sourceRef.sourceComments` (its visible comments, where a playbook has
 * them) are what LOR-251 adds so `voice-metrics.ts`'s echo, language-match
 * and thread-length axes stop being structurally dead on a real campaign
 * draft - `sourceRef` never carried the actual text before this, only
 * identifiers and a title. Clamped here, server-side, to the assist plane's
 * own ceilings (`assist/suggest-prompt.ts`'s
 * MAX_POST_CHARS/MAX_THREAD_COMMENTS/MAX_COMMENT_CHARS/MAX_THREAD_CHARS)
 * regardless of what a playbook actually sent - the same "enforced where
 * the effect happens" rule AGENTS.md already states for the LinkedIn assist
 * switch and every plan limit, applied here to a draft row's storage
 * footprint rather than to a model call. Returns the clamped `sourceRef`
 * (what actually gets persisted, so the jsonb column stays bounded no
 * matter how large a playbook's raw candidate was) alongside the two
 * values the quality computation needs, ready to pass straight through.
 * A draft with neither key (a proactive post, or one drafted before this
 * shipped) comes back with `sourceText: null` - honestly not-measurable,
 * never a guessed empty string.
 */
function clampSourceContext(sourceRef: Record<string, unknown>): {
  sourceRef: Record<string, unknown>;
  sourceText: string | null;
  threadCommentWordCounts: number[] | undefined;
} {
  const clamped: Record<string, unknown> = { ...sourceRef };

  const rawText = sourceRef.sourceText;
  let sourceText: string | null = null;
  if (typeof rawText === 'string' && rawText.trim() !== '') {
    sourceText = rawText.length > MAX_POST_CHARS ? rawText.slice(0, MAX_POST_CHARS) : rawText;
    clamped.sourceText = sourceText;
  } else {
    delete clamped.sourceText;
  }

  const rawComments = sourceRef.sourceComments;
  let threadCommentWordCounts: number[] | undefined;
  if (Array.isArray(rawComments)) {
    const capped = rawComments
      .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      .slice(0, MAX_THREAD_COMMENTS);
    const clampedComments: string[] = [];
    let usedChars = 0;
    for (const c of capped) {
      const body = c.length > MAX_COMMENT_CHARS ? c.slice(0, MAX_COMMENT_CHARS) : c;
      if (usedChars + body.length > MAX_THREAD_CHARS) break;
      usedChars += body.length;
      clampedComments.push(body);
    }
    if (clampedComments.length > 0) {
      clamped.sourceComments = clampedComments;
      threadCommentWordCounts = clampedComments.map(wordCount);
    } else {
      delete clamped.sourceComments;
    }
  } else {
    delete clamped.sourceComments;
  }

  return { sourceRef: clamped, sourceText, threadCommentWordCounts };
}

// Playbooks document their `drafts_create` payloads with an explicit `null`
// for fields that do not apply to the kind being written: every poster
// playbook shows `"targetUser": null` on a `post`, because the audience is
// the thread rather than one user (the commenter playbooks did too until
// #336, which made a comment contact with the post's author). Zod's
// `.optional()` accepts a missing key but NOT an explicit null,
// so a literal, playbook-compliant payload was rejected whole with "invalid
// payload" and the agent lost the entire batch. Treat null as absent, and
// keep the parsed type `T | undefined` so no consumer has to learn a third
// state. `cli/tests/commands/playbook-draft-payloads.test.ts` parses the real
// JSON examples out of the playbooks so the two cannot drift again.
function absentOrNull<T extends z.ZodTypeAny>(inner: T) {
  return inner.nullish().transform((v) => (v == null ? undefined : v));
}

export const DraftInput = z.object({
  accountId: z.number().int(),
  kind: z.enum(['dm', 'post', 'post_comment', 'comment_reply']),
  fitScore: absentOrNull(z.number().int().min(1).max(5)),
  subreddit: absentOrNull(z.string()),
  targetUser: absentOrNull(z.string()),
  title: absentOrNull(z.string()),
  body: z.string().min(1),
  reasoning: absentOrNull(z.string()),
  sourceRef: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? {}),
  metadata: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? {}),
  // Optional A/B variant bodies (issue #20). When provided, `body` is treated
  // as the primary (variant A) and `variants` supplies B, C, ... Each entry
  // produces a sibling draft sharing a `variant_group_id`.
  variants: absentOrNull(z.array(z.string().min(1))),
  // `qualityScore`/`qualityReason` used to be accepted here as the drafting
  // agent's own self-report (issue #41). LOR-229 drops that: the score is
  // now computed server-side in `createDrafts` (`scoreDraftQuality`,
  // `@pitchbox/shared/quality-judge`) from the style checker and the
  // operator's own measured voice, never from what the model that wrote the
  // draft says about itself. An older payload that still sends these two
  // keys is silently accepted and ignored - zod strips unrecognized keys by
  // default - rather than failing the whole batch on a stale playbook.
});

export const Payload = z.array(DraftInput).min(1).max(200);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

// Core draft-creation logic, extracted so both the CLI and the Pitchbox MCP
// server can call it. Applies blocklist + contact-dedup filters, persists the
// surviving drafts, and notifies. Input is already schema-validated (`Payload`).
export async function createDrafts(runId: number, draftsInput: z.infer<typeof Payload>) {
  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.campaignId == null) throw new Error(`run ${runId} has no campaign`);
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, run.campaignId));
  if (!campaign) throw new Error(`campaign ${run.campaignId} not found`);

  // Resolved once (run -> campaign -> project -> organization_id) rather than
  // per draft: contact_history.organization_id is NOT NULL, so every dedup
  // check and the drafts.created notification below share this org id.
  const orgId = await getProjectOrgId(db, campaign.projectId);
  if (orgId == null) {
    throw new Error(`project ${campaign.projectId} has no organization`);
  }

  // Loaded once per batch, not per draft: the rubric and the operator's own
  // corpus profile are both org-level facts every draft in this run shares
  // (LOR-229's deterministic quality score reads both - see the `styled`
  // map below).
  const qualityRubric = await loadQualityRubric(db);
  const corpusProfile = await resolveOperatorCorpusProfile(db, orgId);

  // Validate that every referenced accountId actually belongs to the
  // campaign's project. The accounts FK only requires the account to exist,
  // not that it lives in the same project, so without this check a valid
  // account from another project (or org) would be silently accepted and
  // misattribute the draft's platform identity.
  const accountIds = [...new Set(draftsInput.map((d) => d.accountId))];
  const accountRows = await db
    .select({
      id: schema.accounts.id,
      projectId: schema.accounts.projectId,
      instanceUrl: schema.accounts.instanceUrl,
    })
    .from(schema.accounts)
    .where(inArray(schema.accounts.id, accountIds));
  const accountsById = new Map(accountRows.map((a) => [a.id, a]));
  for (const accountId of accountIds) {
    const account = accountsById.get(accountId);
    if (!account) throw new Error(`account ${accountId} not found`);
    if (account.projectId !== campaign.projectId) {
      throw new Error(
        `account ${accountId} belongs to project ${account.projectId}, not campaign's project ${campaign.projectId}`,
      );
    }
  }

  // `platform.slug` gates the Reddit-only subreddit guard below and also
  // drives server-side compose URL construction further down (issue #325):
  // a `post`/`post_comment` draft cannot be acted on without a subreddit, so
  // refuse to write one rather than storing a row the inbox has to paper
  // over (see the fallback in web/src/lib/platforms/reddit/presenter.ts).
  // Accept the subreddit from either the top-level `subreddit` field or an
  // inline `metadata.subreddit` (both are in active use by the
  // poster/commenter playbooks).
  const [platform] = await db
    .select({ slug: schema.platforms.slug })
    .from(schema.platforms)
    .where(eq(schema.platforms.id, campaign.platformId));
  if (platform?.slug === 'reddit') {
    for (const d of draftsInput) {
      if (d.kind !== 'post' && d.kind !== 'post_comment') continue;
      const metaSubreddit = d.metadata.subreddit;
      const hasSubreddit =
        (typeof d.subreddit === 'string' && d.subreddit.trim() !== '') ||
        (typeof metaSubreddit === 'string' && metaSubreddit.trim() !== '');
      if (!hasSubreddit) {
        throw new Error(
          `Reddit "${d.kind}" draft is missing "subreddit": set the top-level "subreddit" field or metadata.subreddit (targetUser=${d.targetUser ?? 'none'})`,
        );
      }
    }
  }

  // Reddit DM compose URLs carry the subject from campaign.config.offer.subject
  // (issue #325); every other scenario either has no subject or builds its
  // compose URL from the body alone.
  const offerSubject = extractOfferSubject(campaign.config);

  // A `post_comment` is contact with the post's author (issue #336), and the
  // author is already on the run's own staged candidates, so fill it in here
  // rather than trusting every playbook to copy the handle across. This runs
  // ahead of the filter loop on purpose: a derived target then goes through
  // the same blocklist and dedup checks as one the agent supplied, and
  // marking the draft as sent later writes the contact_history row the Inbox
  // dialog promises. Hacker News stages no candidates, so its playbook stays
  // the only source there and a missing author stays null.
  const commentSpec = commentTargetSpec(platform?.slug);
  const needsCommentTarget = draftsInput.some((d) => d.kind === 'post_comment' && !d.targetUser);
  if (commentSpec && needsCommentTarget) {
    const candidates = await db
      .select({ raw: schema.stagingScoutCandidates.raw })
      .from(schema.stagingScoutCandidates)
      .where(eq(schema.stagingScoutCandidates.runId, runId));
    const authorsByPost = indexCandidateAuthors(
      commentSpec,
      candidates.map((c) => c.raw),
    );
    for (const d of draftsInput) {
      if (d.kind !== 'post_comment' || d.targetUser) continue;
      const derived = resolveCommentTargetUser(commentSpec, authorsByPost, d);
      if (derived) d.targetUser = derived;
    }
  }

  // Load dedup policy from app_config.dedup_policy. Defaults to a 90-day
  // warn-only window when unset.
  const [policyRow] = await db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, 'dedup_policy'));
  const dedupPolicy = policyRow ? parseDedupPolicy(policyRow.value) : { ...DEFAULT_DEDUP_POLICY };

  const skipped: Array<{ targetUser: string | null; reason: string | null }> = [];
  const dedupSkipped: Array<{ targetUser: string; priorContactedAt: string }> = [];
  const allowed: Array<(typeof draftsInput)[number] & { dedupWarning?: string }> = [];
  for (const d of draftsInput) {
    if (d.targetUser) {
      const r = await isBlocklisted(db, {
        platformId: campaign.platformId,
        projectId: campaign.projectId,
        targetUser: d.targetUser,
      });
      if (r.blocked) {
        skipped.push({ targetUser: d.targetUser, reason: r.reason });
        continue;
      }
    }

    // Subreddit blocklist: only applies to drafts that post into a subreddit.
    if ((d.kind === 'post' || d.kind === 'post_comment') && d.subreddit) {
      const r = await isSubredditBlocklisted(db, {
        platformId: campaign.platformId,
        projectId: campaign.projectId,
        subreddit: d.subreddit,
      });
      if (r.blocked) {
        skipped.push({ targetUser: d.targetUser ?? null, reason: r.reason });
        continue;
      }
    }

    // Keyword blocklist: scans the draft's title + body regardless of kind.
    const scanText = [d.title, d.body].filter(Boolean).join('\n');
    if (scanText) {
      const r = await isKeywordBlocklisted(db, {
        platformId: campaign.platformId,
        projectId: campaign.projectId,
        text: scanText,
      });
      if (r.blocked) {
        skipped.push({ targetUser: d.targetUser ?? null, reason: r.reason });
        continue;
      }
    }

    // Issue #335: a DM target already known to reject message requests on
    // this platform is skipped outright, ahead of and regardless of the
    // ordinary dedup window/mode below - "cannot be contacted" is not the
    // same fact as "was contacted recently".
    if (d.targetUser && d.kind === 'dm') {
      const uncontactableCheck = await checkUncontactable(db, {
        platformId: campaign.platformId,
        targetUser: d.targetUser,
        organizationId: orgId,
      });
      if (uncontactableCheck.uncontactable) {
        skipped.push({
          targetUser: d.targetUser,
          reason: `uncontactable: ${uncontactableCheck.reason ?? 'unknown reason'}`,
        });
        continue;
      }
    }

    if (d.targetUser) {
      // Dedup check: warn or skip when the same target was contacted within
      // the policy window on this platform.
      const dedup = await checkContactDedup(db, {
        platformId: campaign.platformId,
        targetUser: d.targetUser,
        windowDays: dedupPolicy.windowDays,
        organizationId: orgId,
      });
      if (dedup.withinWindow && dedup.priorContactedAt) {
        if (dedupPolicy.mode === 'skip') {
          dedupSkipped.push({
            targetUser: d.targetUser,
            priorContactedAt: dedup.priorContactedAt.toISOString(),
          });
          continue;
        }
        allowed.push({
          ...d,
          dedupWarning: `Previously contacted on ${dedup.priorContactedAt.toISOString()} (within ${dedupPolicy.windowDays}d window).`,
        });
        continue;
      }
    }
    allowed.push(d);
  }

  // House style (#572) is enforced here, deterministically, before
  // persistence. `drafts:create` runs after the agent turn that wrote the
  // draft has already exited, so there is no live model to send a targeted
  // rewrite instruction back to - `enforceHouseStyle`'s `rewrite` argument
  // is left unset on purpose. Mechanical repair still runs unconditionally
  // (a banned character never reaches the inbox), and any structural
  // finding it cannot fix mechanically travels with the draft in
  // `metadata.styleFindings` rather than being silently accepted: a
  // suggestion the operator can fix beats one he does not know is wrong.
  // Applies to `body` and `title` - the two fields a target actually reads;
  // `reasoning` is operator-facing only and is never sent.
  const styled = await Promise.all(
    allowed.map(async (d) => {
      const bodyResult = await enforceHouseStyle(d.body);
      const titleResult = d.title != null ? await enforceHouseStyle(d.title) : null;
      const variantResults = d.variants
        ? await Promise.all(d.variants.map((v) => enforceHouseStyle(v)))
        : null;
      const styledTitle = titleResult ? titleResult.text : (d.title ?? null);
      const styleFindings = [...bodyResult.findings, ...(titleResult?.findings ?? [])];
      // LOR-251: the source post (and, where the playbook supplied them,
      // its visible comments) this draft answers, clamped and persisted in
      // place of the raw sourceRef so the echo/language-match/thread-length
      // axes below - and a later regeneration, which reads this same
      // sourceRef back - see the same bounded text.
      const { sourceRef, sourceText, threadCommentWordCounts } = clampSourceContext(d.sourceRef);
      // LOR-229: the deterministic (+ optional judged) score for the
      // primary body, and independently for each A/B variant - each is a
      // genuinely different piece of text and gets its own measurement,
      // never one self-report copied across every sibling the way the old
      // agent-reported score was.
      const quality = await scoreDraftQuality(db, {
        body: bodyResult.text,
        title: styledTitle,
        styleFindings,
        corpus: corpusProfile,
        rubric: qualityRubric,
        post: sourceText,
        threadCommentWordCounts,
      });
      const variantQuality = variantResults
        ? await Promise.all(
            variantResults.map((r) =>
              scoreDraftQuality(db, {
                body: r.text,
                title: styledTitle,
                styleFindings: r.findings,
                corpus: corpusProfile,
                rubric: qualityRubric,
                post: sourceText,
                threadCommentWordCounts,
              }),
            ),
          )
        : null;
      return {
        ...d,
        sourceRef,
        styledBody: bodyResult.text,
        styledTitle,
        styleFindings,
        styledVariants: variantResults ? variantResults.map((r) => r.text) : null,
        variantStyleFindings: variantResults ? variantResults.map((r) => r.findings) : null,
        quality,
        variantQuality,
      };
    }),
  );

  const rows = styled.flatMap((d) => {
    const baseMeta = d.subreddit ? { ...d.metadata, subreddit: d.subreddit } : d.metadata;
    if (!d.styledVariants) {
      return [
        {
          runId,
          projectId: campaign.projectId,
          platformId: campaign.platformId,
          accountId: d.accountId,
          kind: d.kind,
          state: 'pending_review' as const,
          fitScore: d.fitScore ?? null,
          targetUser: d.targetUser ?? null,
          title: d.styledTitle,
          body: d.styledBody,
          composeUrl: buildComposeUrl(platform?.slug ?? null, {
            kind: d.kind,
            targetUser: d.targetUser ?? null,
            subreddit: d.subreddit ?? null,
            title: d.styledTitle,
            body: d.styledBody,
            subject: offerSubject,
            instanceUrl: accountsById.get(d.accountId)?.instanceUrl ?? null,
            sourceRef: d.sourceRef,
            metadata: baseMeta,
          }),
          reasoning: d.reasoning ?? null,
          sourceRef: d.sourceRef,
          metadata: {
            ...baseMeta,
            ...(d.styleFindings.length > 0
              ? {
                  styleFindings: d.styleFindings.map((f: StyleFinding) => ({
                    ruleId: f.ruleId,
                    message: f.message,
                    span: f.span,
                  })),
                }
              : {}),
            qualityDetail: d.quality.qualityDetail,
          },
          dedupWarning: d.dedupWarning ?? null,
          variantGroupId: null as string | null,
          variantLabel: null as string | null,
          qualityScore: d.quality.qualityScore,
          qualityReason: d.quality.qualityReason,
          qualityModel: d.quality.qualityModel,
        },
      ];
    }
    const qualityResults = [d.quality, ...(d.variantQuality ?? [])];
    const seeds = [d.styledBody, ...d.styledVariants].map((body, i) => {
      const findings: StyleFinding[] =
        i === 0 ? d.styleFindings : (d.variantStyleFindings?.[i - 1] ?? []);
      return {
        body,
        metadata:
          findings.length > 0
            ? {
                styleFindings: findings.map((f) => ({
                  ruleId: f.ruleId,
                  message: f.message,
                  span: f.span,
                })),
              }
            : undefined,
      };
    });
    const grouped = groupVariants(seeds);
    return grouped.rows.map((r, i) => ({
      runId,
      projectId: campaign.projectId,
      platformId: campaign.platformId,
      accountId: d.accountId,
      kind: d.kind,
      state: 'pending_review' as const,
      fitScore: d.fitScore ?? null,
      targetUser: d.targetUser ?? null,
      title: d.styledTitle,
      body: r.body,
      composeUrl: buildComposeUrl(platform?.slug ?? null, {
        kind: d.kind,
        targetUser: d.targetUser ?? null,
        subreddit: d.subreddit ?? null,
        title: d.styledTitle,
        body: r.body,
        subject: offerSubject,
        instanceUrl: accountsById.get(d.accountId)?.instanceUrl ?? null,
        sourceRef: d.sourceRef,
        metadata: baseMeta,
      }),
      reasoning: d.reasoning ?? null,
      sourceRef: d.sourceRef,
      metadata: {
        ...baseMeta,
        ...(r.metadata ?? {}),
        qualityDetail: qualityResults[i].qualityDetail,
      },
      dedupWarning: d.dedupWarning ?? null,
      variantGroupId: r.variantGroupId,
      variantLabel: r.variantLabel,
      qualityScore: qualityResults[i].qualityScore,
      qualityReason: qualityResults[i].qualityReason,
      qualityModel: qualityResults[i].qualityModel,
    }));
  });

  const inserted =
    rows.length > 0
      ? await db.insert(schema.drafts).values(rows).returning({ id: schema.drafts.id })
      : [];
  if (inserted.length) {
    await db.insert(schema.draftEvents).values(
      inserted.map((i) => ({
        draftId: i.id,
        event: 'created',
        actor: 'system',
        details: {},
      })),
    );
    await notify(
      db,
      {
        kind: 'drafts.created',
        title: `${inserted.length} draft${inserted.length === 1 ? '' : 's'} ready for review`,
        body: `Run #${runId} produced ${inserted.length} draft${inserted.length === 1 ? '' : 's'}.`,
        payload: { runId, count: inserted.length, campaignId: campaign.id },
        severity: 'info',
      },
      orgId,
    );

    // LOR-224: this is the measurement of whether the in-run check works.
    // The playbook is now expected to call the `check_style` MCP tool on
    // each body before ever calling `drafts_create`, and fix what it finds
    // while the model is still in the loop - the one place a structural
    // finding can actually be repaired (see the comment on `styled` above:
    // this backstop has no live model to send a rewrite back to). A run
    // event, not just an in-memory count, is what lets that number be
    // compared across runs after the fact instead of trusted on faith.
    // Written as an `unknown`-kind event (the client's `EventKind` union
    // already renders it via `UnknownEvent`) rather than a new kind, so no
    // client-side type needs to grow for one counter.
    const findingsAtCreate = styled.reduce(
      (sum, d) => sum + d.styleFindings.length + (d.variantStyleFindings?.flat().length ?? 0),
      0,
    );
    const [{ maxSeq }] = await db
      .select({ maxSeq: sql<number>`coalesce(max(${schema.runEvents.seq}), 0)` })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));
    const rawPayload = JSON.stringify({
      runId,
      draftCount: styled.length,
      findingsCount: findingsAtCreate,
    });
    await db.insert(schema.runEvents).values({
      runId,
      seq: maxSeq + 1,
      kind: 'unknown',
      payload: { type: 'unknown', eventType: 'style-findings-at-create', raw: rawPayload },
      raw: rawPayload,
    });
  }

  return { runId, inserted: inserted.length, skipped, dedupSkipped };
}

export async function getDraftById(id: number) {
  if (!Number.isInteger(id)) throw new Error('invalid draft id');
  const db = getDb();
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw new Error(`draft ${id} not found`);
  const messages = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.draftId, id))
    .orderBy(schema.messages.createdAtPlatform);
  return { draft, messages };
}

// `projectId` scopes the query to a single project (used by the Pitchbox MCP
// server, which must never hand an agent a bare scan of every project's
// drafts - see cli/src/mcp/server.ts). Left undefined for the `pitchbox
// drafts:get` CLI command, an operator tool with no per-session scoping.
export async function listDrafts(state?: string, projectId?: number) {
  const db = getDb();
  const conditions = [
    ...(projectId != null ? [eq(schema.drafts.projectId, projectId)] : []),
    ...(state ? [eq(schema.drafts.state, state)] : []),
  ];
  const rows = await db
    .select()
    .from(schema.drafts)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return rows;
}

export async function updateDraftBody(id: number, body: string) {
  if (!Number.isInteger(id)) throw new Error('invalid draft id');
  if (!body || !body.trim()) throw new Error('body is empty');
  const db = getDb();
  const [updated] = await db
    .update(schema.drafts)
    .set({ body })
    .where(eq(schema.drafts.id, id))
    .returning({ id: schema.drafts.id });
  if (!updated) throw new Error(`draft ${id} not found`);
  return { id: updated.id, updated: true };
}

export async function draftRegenStart(runId: number) {
  if (!Number.isInteger(runId)) throw new Error('invalid run id');
  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.kind !== 'draft_regeneration')
    throw new Error(`run ${runId} is not a draft_regeneration run`);
  const params = (run.params ?? {}) as { draftId?: number; hint?: string | null };
  const draftId = params.draftId;
  if (!draftId) throw new Error(`run ${runId} has no draftId in params`);

  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draftId));
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (draft.state !== 'pending_review')
    throw new Error(`draft ${draftId} is ${draft.state}; not regeneratable`);

  const [platform] = await db
    .select({ slug: schema.platforms.slug })
    .from(schema.platforms)
    .where(eq(schema.platforms.id, draft.platformId));

  // Persona: the playbook that created this draft, so the rewrite keeps voice + rules.
  const [origin] = await db.select().from(schema.runs).where(eq(schema.runs.id, draft.runId));
  let persona: string | null = origin?.playbookBody ?? null;
  if (!persona && origin?.campaignId != null) {
    const [campaign] = await db
      .select({ skillSlug: schema.campaigns.skillSlug })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, origin.campaignId));
    if (campaign) {
      const [pb] = await db
        .select({ body: schema.playbooks.body })
        .from(schema.playbooks)
        .where(eq(schema.playbooks.slug, campaign.skillSlug));
      persona = pb?.body ?? null;
    }
  }

  return {
    runId,
    draftId,
    hint: params.hint ?? null,
    platform: platform?.slug ?? null,
    draft: {
      kind: draft.kind,
      title: draft.title,
      body: draft.body,
      targetUser: draft.targetUser,
      reasoning: draft.reasoning,
      sourceRef: draft.sourceRef,
    },
    persona,
  };
}

export async function draftRegenFinish(runId: number, body: string, title?: string | null) {
  if (!Number.isInteger(runId)) throw new Error('invalid run id');
  if (!body || !body.trim()) throw new Error('body is empty');
  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.kind !== 'draft_regeneration')
    throw new Error(`run ${runId} is not a draft_regeneration run`);
  if (run.status !== 'running') throw new Error(`run ${runId} is already ${run.status}`);
  const params = (run.params ?? {}) as { draftId?: number; hint?: string | null };
  const draftId = params.draftId;
  if (!draftId) throw new Error(`run ${runId} has no draftId in params`);

  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draftId));
  if (!draft) throw new Error(`draft ${draftId} not found`);

  const newCount = draft.regenerationCount + 1;
  const newTitle = title ?? draft.title;
  // LOR-229: `draft_regen_finish` still has no live model to send a
  // targeted style-rewrite instruction back to (the playbook calls
  // `check_style` itself, mid-turn, for that) - but `checkStyle` is pure
  // and cheap, so the quality score below measures the rewritten body fresh
  // rather than trusting the agent already ran the check.
  const styleFindings = [...checkStyle(body), ...(newTitle ? checkStyle(newTitle) : [])];
  const orgId = await getProjectOrgId(db, draft.projectId);
  const [corpusProfile, rubric] = await Promise.all([
    orgId != null ? resolveOperatorCorpusProfile(db, orgId) : Promise.resolve(null),
    loadQualityRubric(db),
  ]);
  // LOR-251: re-reads whatever source text/comments the original draft was
  // created with (already clamped by `clampSourceContext` at creation time,
  // re-clamped here anyway for defense in depth - a draft predating this
  // feature simply has no `sourceText` key and comes back `null`, which is
  // the correct, honest answer, not a guess).
  const { sourceText, threadCommentWordCounts } = clampSourceContext(
    (draft.sourceRef ?? {}) as Record<string, unknown>,
  );
  const quality = await scoreDraftQuality(db, {
    body,
    title: newTitle,
    styleFindings,
    corpus: corpusProfile,
    rubric,
    post: sourceText,
    threadCommentWordCounts,
  });
  const priorMeta = (draft.metadata ?? {}) as Record<string, unknown>;
  const newMeta: Record<string, unknown> = { ...priorMeta, qualityDetail: quality.qualityDetail };
  if (styleFindings.length > 0) {
    newMeta.styleFindings = styleFindings.map((f) => ({
      ruleId: f.ruleId,
      message: f.message,
      span: f.span,
    }));
  } else {
    delete newMeta.styleFindings;
  }

  await db.transaction(async (tx) => {
    await tx.insert(schema.draftEvents).values({
      draftId,
      event: 'regenerated',
      actor: 'agent',
      details: {
        hint: params.hint ?? null,
        previousBody: draft.body,
        previousTitle: draft.title,
        regenerationCount: newCount,
      },
    });
    await tx
      .update(schema.drafts)
      .set({
        body,
        title: newTitle,
        version: sql`${schema.drafts.version} + 1`,
        regenerationCount: sql`${schema.drafts.regenerationCount} + 1`,
        regeneratingRunId: null,
        metadata: newMeta,
        qualityScore: quality.qualityScore,
        qualityReason: quality.qualityReason,
        qualityModel: quality.qualityModel,
      })
      .where(eq(schema.drafts.id, draftId));
    await tx
      .update(schema.runs)
      .set({ status: 'success', finishedAt: new Date() })
      .where(eq(schema.runs.id, runId));
  });

  return { draftId, version: draft.version + 1, regenerationCount: newCount };
}

/** Thread context for a `reply_drafting` run: the parent outbound draft (for
 * voice) and the full conversation, both attached to the parent draft, not
 * the reply-placeholder draft itself. Shared by `replyDraftStart` (shown to
 * the drafting agent) and `replyDraftFinish` (LOR-251: read again there to
 * feed the quality computation's source-dependent axes) so the two never
 * disagree about what the conversation actually was. */
async function loadReplyThread(
  db: Db,
  sourceRefValue: unknown,
): Promise<{
  parent: { body: string; reasoning: string | null } | null;
  thread: Array<{
    id: number;
    isFromUs: boolean;
    body: string | null;
    createdAtPlatform: Date | null;
  }>;
}> {
  const sourceRef = (sourceRefValue ?? {}) as { parentDraftId?: number };
  let parent: { body: string; reasoning: string | null } | null = null;
  let thread: Array<{
    id: number;
    isFromUs: boolean;
    body: string | null;
    createdAtPlatform: Date | null;
  }> = [];
  if (sourceRef.parentDraftId) {
    const [p] = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, sourceRef.parentDraftId));
    if (p) parent = { body: p.body, reasoning: p.reasoning };
    // The conversation thread is attached to the PARENT draft, not the reply draft.
    thread = await db
      .select({
        id: schema.messages.id,
        isFromUs: schema.messages.isFromUs,
        body: schema.messages.body,
        createdAtPlatform: schema.messages.createdAtPlatform,
      })
      .from(schema.messages)
      .where(eq(schema.messages.draftId, sourceRef.parentDraftId))
      .orderBy(schema.messages.createdAtPlatform);
  }
  return { parent, thread };
}

export async function replyDraftStart(runId: number) {
  if (!Number.isInteger(runId)) throw new Error('invalid run id');
  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.kind !== 'reply_drafting') throw new Error(`run ${runId} is not a reply_drafting run`);
  const params = (run.params ?? {}) as { replyDraftId?: number; parentMessageId?: number };
  const replyDraftId = params.replyDraftId;
  if (!replyDraftId) throw new Error(`run ${runId} has no replyDraftId in params`);

  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, replyDraftId));
  if (!draft) throw new Error(`reply draft ${replyDraftId} not found`);

  const [platform] = await db
    .select({ slug: schema.platforms.slug })
    .from(schema.platforms)
    .where(eq(schema.platforms.id, draft.platformId));

  const { parent, thread } = await loadReplyThread(db, draft.sourceRef);

  return {
    runId,
    replyDraftId,
    parentMessageId: params.parentMessageId ?? draft.parentMessageId ?? null,
    replyKind: draft.kind,
    replyDraft: {
      targetUser: draft.targetUser,
      accountId: draft.accountId,
      platformId: draft.platformId,
      body: draft.body,
    },
    parent,
    thread,
    platform: platform?.slug ?? null,
  };
}

export async function replyDraftFinish(runId: number, body: string) {
  if (!Number.isInteger(runId)) throw new Error('invalid run id');
  if (!body || !body.trim()) throw new Error('body is empty');
  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.kind !== 'reply_drafting') throw new Error(`run ${runId} is not a reply_drafting run`);
  if (run.status !== 'running') throw new Error(`run ${runId} is already ${run.status}`);
  const params = (run.params ?? {}) as { replyDraftId?: number };
  const replyDraftId = params.replyDraftId;
  if (!replyDraftId) throw new Error(`run ${runId} has no replyDraftId in params`);

  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, replyDraftId));
  if (!draft) throw new Error(`reply draft ${replyDraftId} not found`);

  // LOR-229: same discipline as `draftRegenFinish` - no live model to send a
  // rewrite back to here, but the score still measures the real body fresh.
  const styleFindings = checkStyle(body);
  const orgId = await getProjectOrgId(db, draft.projectId);
  const [corpusProfile, rubric, replyContext] = await Promise.all([
    orgId != null ? resolveOperatorCorpusProfile(db, orgId) : Promise.resolve(null),
    loadQualityRubric(db),
    loadReplyThread(db, draft.sourceRef),
  ]);
  // LOR-251: the message this reply actually answers is the most recent
  // inbound turn, not the parent draft (which is OUR earlier outbound
  // message, kept only for voice) - that feeds echo/language-match. The
  // rest of the visible conversation feeds the length-vs-room axis, the
  // same role a post's visible comment thread plays for a campaign draft.
  const lastInbound = [...replyContext.thread].reverse().find((m) => !m.isFromUs);
  const sourceText = lastInbound?.body ?? null;
  const threadCommentWordCounts = replyContext.thread
    .filter((m): m is (typeof replyContext.thread)[number] & { body: string } => m.body != null)
    .map((m) => wordCount(m.body));
  const quality = await scoreDraftQuality(db, {
    body,
    styleFindings,
    corpus: corpusProfile,
    rubric,
    post: sourceText,
    threadCommentWordCounts,
  });
  const priorMeta = (draft.metadata ?? {}) as Record<string, unknown>;
  const newMeta: Record<string, unknown> = { ...priorMeta, qualityDetail: quality.qualityDetail };
  if (styleFindings.length > 0) {
    newMeta.styleFindings = styleFindings.map((f) => ({
      ruleId: f.ruleId,
      message: f.message,
      span: f.span,
    }));
  } else {
    delete newMeta.styleFindings;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.drafts)
      .set({
        body,
        draftingRunId: null,
        version: sql`${schema.drafts.version} + 1`,
        metadata: newMeta,
        qualityScore: quality.qualityScore,
        qualityReason: quality.qualityReason,
        qualityModel: quality.qualityModel,
      })
      .where(eq(schema.drafts.id, replyDraftId));
    await tx.insert(schema.draftEvents).values({
      draftId: replyDraftId,
      event: 'reply_drafted',
      actor: 'agent',
      details: {},
    });
    await tx
      .update(schema.runs)
      .set({ status: 'success', finishedAt: new Date() })
      .where(eq(schema.runs.id, runId));
  });

  return { draftId: replyDraftId };
}

export function registerDraftCommands(program: Command) {
  program
    .command('drafts:create')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      let json: unknown;
      try {
        json = JSON.parse(await readStdin());
      } catch {
        return fail('invalid JSON on stdin');
      }
      const parsed = Payload.safeParse(json);
      if (!parsed.success) return fail('invalid payload', parsed.error.issues);
      try {
        ok(await createDrafts(Number(opts.run), parsed.data));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('drafts:regenerate')
    .argument('<id>', 'draft id')
    .option('--hint <text>', 'reviewer hint to bias the regeneration')
    .action(async () => {
      fail(
        'regeneration runs in the web app; POST /api/drafts/<id>/regenerate or use the dashboard',
      );
    });

  program
    .command('drafts:get')
    .option('--id <id>', 'fetch a single draft (with its thread messages)')
    .option('--state <state>')
    .option('--project <slug>')
    .action(async (opts: { id?: string; state?: string; project?: string }) => {
      try {
        if (opts.id) ok(await getDraftById(Number(opts.id)));
        else ok(await listDrafts(opts.state));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('drafts:update')
    .requiredOption('--id <id>', 'draft id')
    .action(async (opts: { id: string }) => {
      let json: { body?: unknown };
      try {
        json = JSON.parse(await readStdin());
      } catch {
        return fail('invalid JSON on stdin');
      }
      const body = typeof json.body === 'string' ? json.body : '';
      try {
        ok(await updateDraftBody(Number(opts.id), body));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('drafts:regen:start')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      try {
        ok(await draftRegenStart(Number(opts.run)));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('drafts:regen:finish')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const raw = await readStdin();
      if (!raw || !raw.trim()) return fail('empty payload on stdin');
      let payload: { body?: unknown; title?: unknown };
      try {
        payload = JSON.parse(raw);
      } catch {
        return fail('payload is not valid JSON');
      }
      const body = typeof payload.body === 'string' ? payload.body : '';
      const title = typeof payload.title === 'string' ? payload.title : undefined;
      try {
        ok(await draftRegenFinish(Number(opts.run), body, title));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('drafts:reply:start')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      try {
        ok(await replyDraftStart(Number(opts.run)));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('drafts:reply:finish')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const raw = await readStdin();
      if (!raw || !raw.trim()) return fail('empty payload on stdin');
      let payload: { body?: unknown };
      try {
        payload = JSON.parse(raw);
      } catch {
        return fail('payload is not valid JSON');
      }
      const body = typeof payload.body === 'string' ? payload.body : '';
      try {
        ok(await replyDraftFinish(Number(opts.run), body));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });
}
