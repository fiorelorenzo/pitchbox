/**
 * Thread identifiers used in the `/conversations/[id]` URL.
 *
 * A conversation thread is uniquely keyed by the tuple
 *   (accountHandle, targetUser, platformSlug)
 * which mirrors the natural key of `contact_history` rows.
 *
 * We encode that tuple into a URL-safe base64 string so the dashboard can
 * deep-link to a thread without exposing punctuation that would otherwise need
 * percent-encoding. The encoding is intentionally stable + reversible — the
 * loader decodes it back to the original three fields.
 *
 * Format: base64url(`${accountHandle}|${targetUser}|${platformSlug}`)
 *
 * None of the three components are expected to contain a literal `|` (handles
 * on Reddit are word-character-only, and our `platforms.slug` is also
 * slug-cased), so the simple delimiter is safe. `decodeThreadId` still
 * validates the shape and throws on malformed input.
 */
export type ThreadKey = {
  accountHandle: string;
  targetUser: string;
  platform: string;
};

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const std = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(std, 'base64').toString('utf8');
}

export function encodeThreadId(key: ThreadKey): string {
  if (!key.accountHandle || !key.targetUser || !key.platform) {
    throw new Error('encodeThreadId: all three fields are required');
  }
  if (
    key.accountHandle.includes('|') ||
    key.targetUser.includes('|') ||
    key.platform.includes('|')
  ) {
    // Defensive: if a future platform allowed `|` in handles we'd need a
    // different delimiter. Fail loudly rather than silently corrupting URLs.
    throw new Error('encodeThreadId: pipe character is not allowed in thread key fields');
  }
  return toBase64Url(`${key.accountHandle}|${key.targetUser}|${key.platform}`);
}

export function decodeThreadId(id: string): ThreadKey {
  let raw: string;
  try {
    raw = fromBase64Url(id);
  } catch {
    throw new Error('decodeThreadId: not a valid base64url string');
  }
  const parts = raw.split('|');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new Error('decodeThreadId: malformed thread id');
  }
  const [accountHandle, targetUser, platform] = parts;
  return { accountHandle, targetUser, platform };
}
