import { Command } from 'commander';
import { z } from 'zod';
import { getDb, schema } from '@pitchbox/shared/db';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  isBlocklisted,
  isSubredditBlocklisted,
  isKeywordBlocklisted,
} from '@pitchbox/shared/blocklist';
import { groupVariants } from '@pitchbox/shared/draft-variants';
import {
  checkContactDedup,
  parseDedupPolicy,
  DEFAULT_DEDUP_POLICY,
} from '@pitchbox/shared/contact-dedup';
import { notify } from '@pitchbox/shared/notifications';
import { loadQualityRubric } from '@pitchbox/shared/quality-judge';
import { ok, fail } from '../lib/output.js';

export const DraftInput = z.object({
  accountId: z.number().int(),
  kind: z.enum(['dm', 'post', 'post_comment', 'comment_reply']),
  fitScore: z.number().int().min(1).max(5).optional(),
  subreddit: z.string().optional(),
  targetUser: z.string().optional(),
  title: z.string().optional(),
  body: z.string().min(1),
  composeUrl: z.url().optional(),
  reasoning: z.string().optional(),
  sourceRef: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  // Optional A/B variant bodies (issue #20). When provided, `body` is treated
  // as the primary (variant A) and `variants` supplies B, C, ... Each entry
  // produces a sibling draft sharing a `variant_group_id`.
  variants: z.array(z.string().min(1)).optional(),
  // Inline LLM-judge quality score (issue #41), supplied by the creating agent.
  // Lenient here (clamped at persistence) so one bad score never fails the batch.
  qualityScore: z.number().optional(),
  qualityReason: z.string().optional(),
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

  // Validate that every referenced accountId actually belongs to the
  // campaign's project. The accounts FK only requires the account to exist,
  // not that it lives in the same project, so without this check a valid
  // account from another project (or org) would be silently accepted and
  // misattribute the draft's platform identity.
  const accountIds = [...new Set(draftsInput.map((d) => d.accountId))];
  const accountRows = await db
    .select({ id: schema.accounts.id, projectId: schema.accounts.projectId })
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

    if (d.targetUser) {
      // Dedup check: warn or skip when the same target was contacted within
      // the policy window on this platform.
      const dedup = await checkContactDedup(db, {
        platformId: campaign.platformId,
        targetUser: d.targetUser,
        windowDays: dedupPolicy.windowDays,
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

  const rows = allowed.flatMap((d) => {
    const baseMeta = d.subreddit ? { ...d.metadata, subreddit: d.subreddit } : d.metadata;
    const variantBodies = d.variants && d.variants.length > 0 ? [d.body, ...d.variants] : null;
    if (!variantBodies) {
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
          title: d.title ?? null,
          body: d.body,
          composeUrl: d.composeUrl ?? null,
          reasoning: d.reasoning ?? null,
          sourceRef: d.sourceRef,
          metadata: baseMeta,
          dedupWarning: d.dedupWarning ?? null,
          variantGroupId: null as string | null,
          variantLabel: null as string | null,
          qualityScore:
            d.qualityScore != null ? Math.max(0, Math.min(100, Math.round(d.qualityScore))) : null,
          qualityReason: d.qualityScore != null ? (d.qualityReason ?? null) : null,
          qualityModel: d.qualityScore != null ? run.agentRunner : null,
        },
      ];
    }
    const grouped = groupVariants(variantBodies.map((b) => ({ body: b })));
    return grouped.rows.map((r) => ({
      runId,
      projectId: campaign.projectId,
      platformId: campaign.platformId,
      accountId: d.accountId,
      kind: d.kind,
      state: 'pending_review' as const,
      fitScore: d.fitScore ?? null,
      targetUser: d.targetUser ?? null,
      title: d.title ?? null,
      body: r.body,
      composeUrl: d.composeUrl ?? null,
      reasoning: d.reasoning ?? null,
      sourceRef: d.sourceRef,
      metadata: baseMeta,
      dedupWarning: d.dedupWarning ?? null,
      variantGroupId: r.variantGroupId,
      variantLabel: r.variantLabel,
      qualityScore:
        d.qualityScore != null ? Math.max(0, Math.min(100, Math.round(d.qualityScore))) : null,
      qualityReason: d.qualityScore != null ? (d.qualityReason ?? null) : null,
      qualityModel: d.qualityScore != null ? run.agentRunner : null,
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
    await notify(db, {
      kind: 'drafts.created',
      title: `${inserted.length} draft${inserted.length === 1 ? '' : 's'} ready for review`,
      body: `Run #${runId} produced ${inserted.length} draft${inserted.length === 1 ? '' : 's'}.`,
      payload: { runId, count: inserted.length, campaignId: campaign.id },
      severity: 'info',
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

export async function listDrafts(state?: string) {
  const db = getDb();
  const rows = await db.select().from(schema.drafts);
  return state ? rows.filter((r) => r.state === state) : rows;
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

  const rubric = await loadQualityRubric(db);

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
    rubricTemplate: rubric.rubric_template,
  };
}

export async function draftRegenFinish(
  runId: number,
  body: string,
  title?: string | null,
  qualityScore?: number | null,
  qualityReason?: string | null,
) {
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
  const qualitySet =
    qualityScore != null
      ? {
          qualityScore: Math.max(0, Math.min(100, Math.round(qualityScore))),
          qualityReason: qualityReason ?? null,
          qualityModel: run.agentRunner,
        }
      : {};
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
        title: title ?? draft.title,
        version: sql`${schema.drafts.version} + 1`,
        regenerationCount: sql`${schema.drafts.regenerationCount} + 1`,
        regeneratingRunId: null,
        ...qualitySet,
      })
      .where(eq(schema.drafts.id, draftId));
    await tx
      .update(schema.runs)
      .set({ status: 'success', finishedAt: new Date() })
      .where(eq(schema.runs.id, runId));
  });

  return { draftId, version: draft.version + 1, regenerationCount: newCount };
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

  const sourceRef = (draft.sourceRef ?? {}) as { parentDraftId?: number };
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

  const rubric = await loadQualityRubric(db);

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
    rubricTemplate: rubric.rubric_template,
  };
}

export async function replyDraftFinish(
  runId: number,
  body: string,
  qualityScore?: number | null,
  qualityReason?: string | null,
) {
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

  const qualitySet =
    qualityScore != null
      ? {
          qualityScore: Math.max(0, Math.min(100, Math.round(qualityScore))),
          qualityReason: qualityReason ?? null,
          qualityModel: run.agentRunner,
        }
      : {};
  await db.transaction(async (tx) => {
    await tx
      .update(schema.drafts)
      .set({
        body,
        draftingRunId: null,
        version: sql`${schema.drafts.version} + 1`,
        ...qualitySet,
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
      let payload: {
        body?: unknown;
        title?: unknown;
        qualityScore?: unknown;
        qualityReason?: unknown;
      };
      try {
        payload = JSON.parse(raw);
      } catch {
        return fail('payload is not valid JSON');
      }
      const body = typeof payload.body === 'string' ? payload.body : '';
      const title = typeof payload.title === 'string' ? payload.title : undefined;
      const qualityScore =
        typeof payload.qualityScore === 'number' ? payload.qualityScore : undefined;
      const qualityReason =
        typeof payload.qualityReason === 'string' ? payload.qualityReason : undefined;
      try {
        ok(await draftRegenFinish(Number(opts.run), body, title, qualityScore, qualityReason));
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
      let payload: { body?: unknown; qualityScore?: unknown; qualityReason?: unknown };
      try {
        payload = JSON.parse(raw);
      } catch {
        return fail('payload is not valid JSON');
      }
      const body = typeof payload.body === 'string' ? payload.body : '';
      const qualityScore =
        typeof payload.qualityScore === 'number' ? payload.qualityScore : undefined;
      const qualityReason =
        typeof payload.qualityReason === 'string' ? payload.qualityReason : undefined;
      try {
        ok(await replyDraftFinish(Number(opts.run), body, qualityScore, qualityReason));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });
}
