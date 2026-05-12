import { Command } from 'commander';
import { z } from 'zod';
import { getDb, schema } from '@pitchbox/shared/db';
import { eq } from 'drizzle-orm';
import { isBlocklisted } from '@pitchbox/shared/blocklist';
import { regenerateDraft } from '@pitchbox/shared/draft-regenerate';
import { scoreDraft } from '@pitchbox/shared/quality-judge';
import { groupVariants } from '@pitchbox/shared/draft-variants';
import {
  checkContactDedup,
  parseDedupPolicy,
  DEFAULT_DEDUP_POLICY,
} from '@pitchbox/shared/contact-dedup';
import { notify } from '@pitchbox/shared/notifications';
import { ok, fail } from '../lib/output.js';

const DraftInput = z.object({
  accountId: z.number().int(),
  kind: z.enum(['dm', 'post', 'post_comment', 'comment_reply']),
  fitScore: z.number().int().min(1).max(5).optional(),
  subreddit: z.string().optional(),
  targetUser: z.string().optional(),
  title: z.string().optional(),
  body: z.string().min(1),
  composeUrl: z.string().url().optional(),
  reasoning: z.string().optional(),
  sourceRef: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
  // Optional A/B variant bodies (issue #20). When provided, `body` is treated
  // as the primary (variant A) and `variants` supplies B, C, ... Each entry
  // produces a sibling draft sharing a `variant_group_id`.
  variants: z.array(z.string().min(1)).optional(),
});

const Payload = z.array(DraftInput).min(1).max(200);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

export function registerDraftCommands(program: Command) {
  program
    .command('drafts:create')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const runId = Number(opts.run);
      const db = getDb();
      const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run) return fail(`run ${runId} not found`);
      if (run.campaignId == null) return fail(`run ${runId} has no campaign`);
      const [campaign] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, run.campaignId));

      const body = await readStdin();
      const parsed = Payload.safeParse(JSON.parse(body));
      if (!parsed.success) return fail('invalid payload', parsed.error.issues);

      // Load dedup policy from app_config.dedup_policy. Defaults to a 90-day
      // warn-only window when unset.
      const [policyRow] = await db
        .select()
        .from(schema.appConfig)
        .where(eq(schema.appConfig.key, 'dedup_policy'));
      const dedupPolicy = policyRow
        ? parseDedupPolicy(policyRow.value)
        : { ...DEFAULT_DEDUP_POLICY };

      const skipped: Array<{ targetUser: string; reason: string | null }> = [];
      const dedupSkipped: Array<{ targetUser: string; priorContactedAt: string }> = [];
      const allowed: Array<(typeof parsed.data)[number] & { dedupWarning?: string }> = [];
      for (const d of parsed.data) {
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

      ok({ runId, inserted: inserted.length, skipped, dedupSkipped });
    });

  program
    .command('drafts:regenerate')
    .argument('<id>', 'draft id')
    .option('--hint <text>', 'reviewer hint to bias the regeneration')
    .action(async (idArg: string, opts: { hint?: string }) => {
      const draftId = Number(idArg);
      if (!Number.isInteger(draftId)) return fail('invalid draft id');
      const db = getDb();
      const [existing] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draftId));
      if (!existing) return fail(`draft ${draftId} not found`);
      // Runner invocation is stubbed; we bump the counter, persist the hint,
      // and append a `regenerated` draft_event. The agent runner will plug in
      // here once the `regenerate-single` mode lands in the playbook layer.
      const res = await regenerateDraft(db, {
        draftId,
        hint: opts.hint ?? null,
        actor: 'cli',
      });
      ok(res);
    });

  program
    .command('drafts:score')
    .argument('<id>', 'draft id')
    .description('Run the LLM-judge quality scorer against a draft (stub V1).')
    .action(async (idArg: string) => {
      const draftId = Number(idArg);
      if (!Number.isInteger(draftId)) return fail('invalid draft id');
      const db = getDb();
      try {
        const res = await scoreDraft(db, draftId);
        ok(res);
      } catch (err) {
        return fail(String((err as Error).message ?? err));
      }
    });

  program
    .command('drafts:get')
    .option('--state <state>')
    .option('--project <slug>')
    .action(async (opts: { state?: string; project?: string }) => {
      const db = getDb();
      const rows = await db.select().from(schema.drafts);
      const filtered = rows.filter((r) => {
        if (opts.state && r.state !== opts.state) return false;
        return true;
      });
      ok(filtered);
    });
}
