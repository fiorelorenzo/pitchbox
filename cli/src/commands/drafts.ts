import { Command } from 'commander';
import { z } from 'zod';
import { getDb, schema } from '@pitchbox/shared/db';
import { eq } from 'drizzle-orm';
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
      const [campaign] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, run.campaignId));

      const body = await readStdin();
      const parsed = Payload.safeParse(JSON.parse(body));
      if (!parsed.success) return fail('invalid payload', parsed.error.issues);

      const rows = parsed.data.map((d) => ({
        runId,
        projectId: campaign.projectId,
        platformId: campaign.platformId,
        accountId: d.accountId,
        kind: d.kind,
        state: 'pending_review' as const,
        fitScore: d.fitScore ?? null,
        subreddit: d.subreddit ?? null,
        targetUser: d.targetUser ?? null,
        title: d.title ?? null,
        body: d.body,
        composeUrl: d.composeUrl ?? null,
        reasoning: d.reasoning ?? null,
        sourceRef: d.sourceRef,
        metadata: d.metadata,
      }));

      const inserted = await db
        .insert(schema.drafts)
        .values(rows)
        .returning({ id: schema.drafts.id });
      if (inserted.length) {
        await db.insert(schema.draftEvents).values(
          inserted.map((i) => ({
            draftId: i.id,
            event: 'created',
            actor: 'system',
            details: {},
          })),
        );
      }

      ok({ runId, inserted: inserted.length });
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
