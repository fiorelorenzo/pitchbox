import { getExtensionToken, getExtensionTokenCreatedAt } from '@pitchbox/shared/extension-token';
import { loadQuotaLimits } from '@pitchbox/shared/quota';
import { getDb } from '$lib/server/db.js';

export async function load() {
  const quota = await loadQuotaLimits(getDb(), 'reddit');
  return {
    extension: {
      token: await getExtensionToken(),
      createdAt: await getExtensionTokenCreatedAt(),
      backendUrl: process.env.PITCHBOX_BACKEND_URL ?? 'http://127.0.0.1:5180',
    },
    quota: { reddit: quota },
  };
}
