import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { NullReplyReader, type ReplyReader } from '@pitchbox/shared/platforms/reply-reader';
import {
  MastodonReplyReader,
  clientFromMastodonAccount,
  type MastodonClient,
} from '@pitchbox/shared/platforms/mastodon';

/**
 * Resolves the Mastodon client for an account handle: looks up the
 * `accounts` row (platform 'mastodon', matching `handle`) and builds a
 * client from its stored instanceUrl + encrypted access token
 * (`clientFromMastodonAccount`, MAS-1). Replaces the earlier stopgap that
 * always threw because per-account credential storage did not exist yet.
 */
export async function resolveMastodonClient(accountHandle: string): Promise<MastodonClient> {
  const db = getDb();
  const [account] = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.platforms, eq(schema.accounts.platformId, schema.platforms.id))
    .where(and(eq(schema.platforms.slug, 'mastodon'), eq(schema.accounts.handle, accountHandle)));
  if (!account) {
    throw new Error(`no Mastodon account found for handle "${accountHandle}"`);
  }
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error('ENCRYPTION_KEY must be set');
  return clientFromMastodonAccount(account.accounts, encryptionKey);
}

/**
 * Platform slug → reply reader. We register a NullReplyReader for every platform
 * we know about until a real implementation lands. Swap in the real reader here
 * when ready; the poller picks up the change without any other code edits.
 */
const readers = new Map<string, ReplyReader>([
  ['reddit', new NullReplyReader('reddit')],
  ['mastodon', new MastodonReplyReader(resolveMastodonClient)],
]);

export function getReplyReader(platformSlug: string): ReplyReader | null {
  return readers.get(platformSlug) ?? null;
}

export function registerReplyReader(reader: ReplyReader): void {
  readers.set(reader.platform, reader);
}

/**
 * Platform slugs backed by a real (non-Null) reply reader. The poller only
 * polls these - a NullReplyReader is inert by design (e.g. Reddit's reply
 * detection runs through the Chrome extension instead; see AGENTS.md).
 */
export function getActiveReplyReaderPlatforms(): string[] {
  return [...readers.entries()]
    .filter(([, reader]) => !(reader instanceof NullReplyReader))
    .map(([slug]) => slug);
}
