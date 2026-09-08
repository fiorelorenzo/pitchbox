import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import {
  MODEL_FUNCTIONS,
  loadModelFunctionConfig,
  saveModelFunctionModel,
  type ModelFunction,
} from '@pitchbox/shared/ai/model-functions';

// Which model does which job (#411). Instance-wide configuration, so
// `requireInstanceAdmin` rather than `requireRole`, matching the other
// instance-wide writes on this rail (default-runner, runner-config, quota).

const Body = z.object({
  fn: z.enum(MODEL_FUNCTIONS),
  /**
   * An empty string clears the setting, which resolves back to the coded
   * default rather than to nothing. That is the reason the stored value is
   * nullable: an operator who clears the field is picking the default, not
   * breaking every run of that job.
   */
  modelId: z.string().max(200),
});

export async function GET(event: RequestEvent) {
  await requireInstanceAdmin(event);
  return json(await loadModelFunctionConfig(getDb()));
}

export async function POST(event: RequestEvent) {
  await requireInstanceAdmin(event);
  const parsed = Body.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) throw error(400, parsed.error.issues[0]?.message ?? 'invalid body');
  const { fn, modelId } = parsed.data;
  await saveModelFunctionModel(getDb(), fn as ModelFunction, modelId.trim() ? modelId : null);
  return json(await loadModelFunctionConfig(getDb()));
}
