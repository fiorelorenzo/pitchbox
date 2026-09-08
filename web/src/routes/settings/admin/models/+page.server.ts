import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import { MODEL_FUNCTION_META, loadModelFunctionConfig } from '@pitchbox/shared/ai/model-functions';
import { loadGatewayCatalogue } from '@pitchbox/shared/ai/gateway-catalogue';

// Which model does which job, for the operator of the deployment rather than
// for a member of one organization (#411, inside the area #412 built). The
// area's `+layout.server.ts` already gates the whole subtree, and this loader
// gates itself again: the write path next door does the same, and the API is
// the boundary that holds when somebody types a URL rather than following a
// link that was hidden from them.

export const load: PageServerLoad = async (event) => {
  await requireInstanceAdmin(event);
  const db = getDb();
  const [configured, catalogue] = await Promise.all([
    loadModelFunctionConfig(db),
    loadGatewayCatalogue(),
  ]);
  return {
    functions: MODEL_FUNCTION_META.map((meta) => ({
      fn: meta.fn,
      label: meta.label,
      description: meta.description,
      defaultModelId: meta.defaultModelId,
      configuredModelId: configured[meta.fn],
    })),
    catalogue: {
      models: catalogue.models,
      unavailable: catalogue.unavailable,
    },
  };
};
