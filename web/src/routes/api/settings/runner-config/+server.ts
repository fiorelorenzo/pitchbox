import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import {
  loadRunnerConfigs,
  saveRunnerConfig,
  type RunnerConfig,
} from '@pitchbox/shared/agents/config';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { z } from 'zod';
import { requireInstanceAdmin } from '$lib/server/auth.js';

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

export async function GET() {
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
  await saveRunnerConfig(db, parsed.data.slug, parsed.data.config as RunnerConfig);
  const configs = await loadRunnerConfigs(db);
  return json({ configs });
}
