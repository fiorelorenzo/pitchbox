import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { MastodonClient } from '@pitchbox/shared/platforms/mastodon';
import { encrypt } from '@pitchbox/shared/crypto';

// Connect a Mastodon account: paste the instance URL + a developer access
// token (instance Preferences -> Development -> New application, scopes
// read + write). The token is validated against the instance via
// verify_credentials BEFORE anything is persisted; on success the account is
// stored with handle = "@user@instance" and the token encrypted at rest.
const PostBody = z.object({
  instanceUrl: z.string().url(),
  accessToken: z.string().min(1),
  role: z.enum(['personal', 'brand']).optional(),
});

function parseId(p: string | undefined): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  requireRole(event, 'admin');

  const raw = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    return json({ error: 'encryption_key_not_configured' }, { status: 500 });
  }

  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'mastodon'));
  if (!platform) {
    return json({ error: 'unknown_platform' }, { status: 400 });
  }

  const instanceUrl = parsed.data.instanceUrl.replace(/\/+$/, '');
  const client = new MastodonClient({ instanceUrl, accessToken: parsed.data.accessToken });
  let verified;
  try {
    verified = await client.verifyCredentials();
  } catch {
    return json(
      {
        error: 'invalid_token',
        message:
          'Could not verify the access token against that instance. Check the URL and token and try again.',
      },
      { status: 400 },
    );
  }

  const host = new URL(instanceUrl).host;
  const handle = `@${verified.username}@${host}`;

  const [row] = await db
    .insert(schema.accounts)
    .values({
      projectId: id,
      platformId: platform.id,
      handle,
      role: parsed.data.role ?? 'personal',
      instanceUrl,
      accessTokenEncrypted: encrypt(parsed.data.accessToken, encryptionKey),
    })
    .returning();

  return json({ account: row }, { status: 201 });
}
