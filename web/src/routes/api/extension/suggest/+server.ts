import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import { runSuggestion } from '$lib/server/suggest.js';
import { loadActiveTemplates } from '@pitchbox/shared/templates';
import { getAccountUsage, checkQuota, loadQuotaLimits } from '@pitchbox/shared/quota';
import { mapDraftKindToQuotaKind } from '@pitchbox/shared/quota-types';
import { MAX_POST_CHARS, type SuggestionKind } from '@pitchbox/shared/assist/suggest-prompt';

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

const BodySchema = z.object({
  projectId: z.number().int().positive(),
  kind: z.enum(['post_comment', 'post']),
  post: z.object({
    urn: z.string().max(200).optional(),
    authorHandle: z.string().max(200).optional(),
    authorName: z.string().max(200).optional(),
    text: z
      .string()
      .min(1)
      .max(MAX_POST_CHARS * 2),
    url: z.string().max(2000).optional(),
  }),
  hint: z.string().max(500).optional(),
  platform: z.string().min(1).max(40).default('linkedin'),
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
  // nothing about other tenants' ids. A null-org device (self-host, auth off)
  // is unrestricted, mirroring requireRole.
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

  // Suggesting what cannot be sent wastes the human's attention and a model
  // call, so the platform's own daily quota is a precondition and not a
  // post-hoc check. The refusal is a 200 with a body the panel can render:
  // a 500 would look like a defect, and this is the system working.
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, body.platform))
    .limit(1);
  if (!platform) throw error(400, `unknown platform: ${body.platform}`);

  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.projectId, project.id),
        eq(schema.accounts.platformId, platform.id),
        eq(schema.accounts.active, true),
      ),
    )
    .limit(1);

  if (account) {
    const quotaKind = mapDraftKindToQuotaKind(body.kind);
    const [limits, usage] = await Promise.all([
      loadQuotaLimits(db, platform.slug),
      getAccountUsage(db, account.id),
    ]);
    const day = checkQuota({
      platformLimit: limits[quotaKind].perDay,
      accountLimit: account.dailyLimit,
      used: usage[quotaKind].day,
    });
    if (day.remaining <= 0) {
      return json({
        refused: 'quota_exhausted',
        kind: quotaKind,
        window: 'day',
        limit: day.limit,
        used: day.used,
        boundBy: day.kind,
      });
    }
  }

  const examples = (
    await loadActiveTemplates(db, {
      projectId: project.id,
      kind: body.kind === 'post' ? 'post' : 'comment',
    })
  ).map((t) => ({ title: t.title, body: t.body }));

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

      const handle = runSuggestion({
        kind: body.kind as SuggestionKind,
        post: body.post,
        project: { name: project.name, description: project.description, examples },
        hint: body.hint,
        projectId: project.id,
        orgId: auth.organizationId ?? undefined,
        runnerSlug: project.defaultAgentRunner,
        onFirstChunk: () => send('status', { phase: 'writing' }),
        onChunk: (text) => send('chunk', { text }),
      });
      cancel = handle.cancel;

      handle.result
        .then((res) => {
          if (settled) return;
          settled = true;
          send('done', { text: res.text, usage: res.usage, ms: res.ms });
          controller.close();
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
