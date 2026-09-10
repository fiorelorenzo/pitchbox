import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import {
  loadRunnerConfig,
  loadRunnerConfigs,
  saveRunnerConfig,
  type RunnerConfig,
} from '@pitchbox/shared/agents/config';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { z } from 'zod';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';
import { isCloud } from '@pitchbox/shared/edition';
import { requireInstanceAdmin, requireRole } from '$lib/server/auth.js';

const ConfigSchema = z.object({
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  extraArgs: z.array(z.string()).optional(),
});

const PutBody = z.object({
  slug: z.string(),
  config: ConfigSchema,
});

function isRunnerSlug(slug: string): slug is AgentRunnerSlug {
  return AGENT_RUNNER_META.some((m) => m.slug === slug);
}

// Same view/mutate split as settings/+page.server.ts: viewing per-runner
// config is gated to the per-org 'admin' role on self-host; on cloud that
// role is not the right axis (#183, any user can self-create an org and
// become its admin/owner), so the read narrows to `requireInstanceAdmin`
// there too. Changing it is instance-wide config either way, so it always
// needed the stricter requireInstanceAdmin (#137).
export async function GET(event: RequestEvent) {
  if (isCloud()) {
    await requireInstanceAdmin(event);
  } else {
    requireRole(event, 'admin');
  }
  const db = getDb();
  const configs = await loadRunnerConfigs(db);
  return json({ configs });
}

export async function PUT(event: RequestEvent) {
  const { request } = event;
  await requireInstanceAdmin(event);
  const body = await request.json();
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) throw error(400, 'invalid body');
  if (!isRunnerSlug(parsed.data.slug)) throw error(400, 'unknown runner');
  const db = getDb();
  const before = await loadRunnerConfig(db, parsed.data.slug);
  await saveRunnerConfig(db, parsed.data.slug, parsed.data.config as RunnerConfig);
  await recordInstanceAudit(db, {
    key: `runner_config:${parsed.data.slug}`,
    actor: event.locals.user ?? null,
    before,
    after: parsed.data.config,
  });
  const configs = await loadRunnerConfigs(db);
  return json({ configs });
}
