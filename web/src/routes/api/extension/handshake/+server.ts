import { json } from '@sveltejs/kit';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import pkg from '../../../../../package.json';

// Bundled at build time from web/package.json, the same source the dashboard
// sidebar reads (see $lib/shared/version.ts). It used to be
// `process.env.npm_package_version`, which is only set when the process was
// started by a package-manager script: the deployed container runs `node
// --import tsx` directly, so every real install saw the fallback and the
// extension's "Test connection" reported "Connected - server v0.0.0" (#379).
const VERSION = pkg.version;

export async function POST({ request }: { request: Request }) {
  await requireExtensionAuth(request);
  return json({ ok: true, version: VERSION });
}
