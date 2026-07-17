import { decrypt } from '../../crypto.js';
import { MastodonClient, type MastodonClientOptions } from './client.js';

/**
 * The subset of an `accounts` row this resolver needs. Kept as a minimal
 * structural type (rather than importing the Drizzle row type) so this
 * module stays decoupled from `shared/src/db`.
 */
export interface MastodonAccountCredentials {
  instanceUrl: string | null;
  accessTokenEncrypted: string | null;
}

/**
 * Builds a `MastodonClient` for a stored account row: decrypts the access
 * token with `ENCRYPTION_KEY` (via shared/src/crypto.ts) and pairs it with
 * the account's instance URL. Throws a clear error when the account has no
 * Mastodon credentials connected yet, or when decryption fails (wrong/rotated
 * key, corrupted ciphertext).
 */
export function clientFromMastodonAccount(
  account: MastodonAccountCredentials,
  encryptionKey: string,
  opts: Partial<Omit<MastodonClientOptions, 'instanceUrl' | 'accessToken'>> = {},
): MastodonClient {
  if (!account.instanceUrl || !account.accessTokenEncrypted) {
    throw new Error(
      'account has no Mastodon credentials connected (instance URL + access token required)',
    );
  }
  const accessToken = decrypt(account.accessTokenEncrypted, encryptionKey);
  return new MastodonClient({ instanceUrl: account.instanceUrl, accessToken, ...opts });
}
