import { error } from '@sveltejs/kit';
import { verifyExtensionToken } from '@pitchbox/shared/extension-token';

export async function requireExtensionAuth(request: Request): Promise<void> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) throw error(401, 'missing bearer token');
  const ok = await verifyExtensionToken(match[1]);
  if (!ok) throw error(401, 'invalid token');
}
