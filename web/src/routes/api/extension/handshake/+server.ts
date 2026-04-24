import { json } from '@sveltejs/kit';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';

const VERSION = process.env.npm_package_version ?? '0.0.0';

export async function POST({ request }: { request: Request }) {
  await requireExtensionAuth(request);
  return json({ ok: true, version: VERSION });
}
