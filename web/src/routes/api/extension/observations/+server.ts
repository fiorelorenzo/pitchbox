import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import {
  ingestObservedTargets,
  MAX_OBSERVED_TARGETS_BATCH,
} from '@pitchbox/shared/observed-targets';
import { loadLinkedInAssistDeviceState } from '@pitchbox/shared/linkedin-assist';

// Server side of the observation buffer (#301): the extension's content
// script watches linkedin.com passively and posts what it saw here, on a
// debounce, so a LinkedIn campaign has candidates without a discovery API
// (docs/linkedin-integration-design.md, "Observation collection").

// Per device. A human actively scrolling can produce several debounced
// batches a minute, so this is looser than /suggest's perDevice(20, 60_000)
// while still bounding what a stolen token can spend.
const perDevice = new RateLimiter(30, 60_000);

// Elements are validated per item by ingestObservedTargets
// (shared/src/observed-targets.ts) and dropped individually rather than
// failing the whole batch - the extension builds these from raw DOM reads,
// so one degenerate sighting must not lose the rest of a debounce tick (same
// posture as IncomingDmSchema in .../dm-sync/+server.ts, #182).
const BodySchema = z.object({
  platform: z.string().min(1),
  projectId: z.number().int().positive(),
  items: z.array(z.unknown()).max(MAX_OBSERVED_TARGETS_BATCH),
});

export async function POST({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);

  // Consumed before any await: a burst of concurrent requests for the same
  // device can't all slip past the check before any of them records an
  // attempt (see rate-limit.ts's own doc comment).
  if (!perDevice.consume(`device:${auth.deviceId}`)) {
    throw error(429, 'too many observations');
  }

  const raw = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid body');
  const body = parsed.data;

  const db = getDb();

  // Org scoping is not optional: a device bound to an org may only write
  // against one of its own projects. An id that doesn't resolve for this org
  // 404s rather than 403s, matching assertDraftInDeviceOrg - it leaks
  // nothing about other tenants' ids. A null-org device (self-host / auth
  // off) is unrestricted, mirroring requireRole's no-op there.
  const [project] = await db
    .select({ id: schema.projects.id, organizationId: schema.projects.organizationId })
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
  if (!platform) throw error(404, 'unknown platform');

  // Same reason as the suggest route: #316 shipped the collector switch and
  // the kill switch, and the collector is supposed to be off by default, but
  // nothing here refused a post that ignored either. An extension build that
  // never polls the read path, or a tab whose content script predates the
  // flip, would keep filling the buffer with third-party post text an admin
  // has explicitly said not to collect. Gated on the LinkedIn switch only,
  // since `linkedin_assist` is what the setting names.
  if (platform.slug === 'linkedin') {
    const assist = await loadLinkedInAssistDeviceState(db, project.organizationId);
    if (!assist.collectorEnabled) {
      // 403 rather than the suggest route's renderable 200: this caller is a
      // background collector with no human waiting on a rendered answer, and
      // a hard refusal is what makes it stop.
      throw error(403, assist.killSwitch ? 'kill_switch' : 'collector_disabled');
    }
    if (assist.projectId !== project.id) {
      throw error(403, 'project_not_bound');
    }
  }

  // Delegate the write and the dedup entirely to LI-3's ingest service - no
  // hand-rolled insert here. `body.items` is passed through unvalidated:
  // ingestObservedTargets does the per-item zod check and reports how many
  // it dropped. Never log the items themselves; `text`/`authorName` are
  // third-party LinkedIn content, not ours to put in server logs.
  const result = await ingestObservedTargets(db, {
    organizationId: project.organizationId,
    projectId: project.id,
    platformId: platform.id,
    observations: body.items,
  });

  // `written` only reports rows that actually landed post-dedup, so the
  // duplicate count is everything that validated but didn't make it in.
  const validCount = body.items.length - result.rejected;
  return json({
    ok: true,
    inserted: result.written.length,
    duplicates: validCount - result.written.length,
    dropped: result.rejected,
  });
}
