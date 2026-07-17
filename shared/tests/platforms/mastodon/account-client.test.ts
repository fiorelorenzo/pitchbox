import { describe, expect, it, vi } from 'vitest';
import { clientFromMastodonAccount } from '../../../src/platforms/mastodon/account-client.js';
import { encrypt } from '../../../src/crypto.js';

const KEY = 'b'.repeat(64); // 32 bytes hex

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('clientFromMastodonAccount', () => {
  it('decrypts the stored access token and builds a client that authenticates with it', async () => {
    const accessToken = 'super-secret-token';
    const account = {
      instanceUrl: 'https://mastodon.example',
      accessTokenEncrypted: encrypt(accessToken, KEY),
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: '1', username: 'alice' }));

    const client = clientFromMastodonAccount(account, KEY, { fetchImpl });
    await client.verifyCredentials();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://mastodon.example/api/v1/accounts/verify_credentials',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${accessToken}` }),
      }),
    );
  });

  it('throws a clear error when the account has no instance URL connected', () => {
    const account = { instanceUrl: null, accessTokenEncrypted: encrypt('x', KEY) };
    expect(() => clientFromMastodonAccount(account, KEY)).toThrow(
      /no Mastodon credentials connected/,
    );
  });

  it('throws a clear error when the account has no access token connected', () => {
    const account = { instanceUrl: 'https://mastodon.example', accessTokenEncrypted: null };
    expect(() => clientFromMastodonAccount(account, KEY)).toThrow(
      /no Mastodon credentials connected/,
    );
  });

  it('throws when the encryption key cannot decrypt the stored token (wrong key)', () => {
    const account = {
      instanceUrl: 'https://mastodon.example',
      accessTokenEncrypted: encrypt('secret', KEY),
    };
    expect(() => clientFromMastodonAccount(account, 'c'.repeat(64))).toThrow();
  });
});
