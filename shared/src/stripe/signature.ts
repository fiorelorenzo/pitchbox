// Verifies the `Stripe-Signature` header Stripe attaches to every webhook
// delivery, without the `stripe` npm package (see `client.ts` for why this
// integration stays on raw `fetch`/`node:crypto` throughout). The algorithm
// is Stripe's own (https://docs.stripe.com/webhooks#verify-manually):
// `v1=` is `HMAC-SHA256(webhookSecret, "<timestamp>.<rawBody>")` hex-encoded,
// and the header carries one or more `v1=` values (a secret rotation sends
// two) plus the `t=` timestamp used to build the signed payload and to
// reject a stale request. The raw, unparsed request body is required - a
// route that reads it as JSON first has already lost the exact bytes this
// computation needs.
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * `true` only if `header` carries a `v1` signature matching `secret` over
 * `rawBody`, computed at the header's own `t=` timestamp, and that
 * timestamp is within `toleranceSeconds` of now. Every failure mode -
 * missing `t=`, no `v1=` entry, a mismatched HMAC, or a stale timestamp -
 * returns `false` rather than throwing, since the caller's only decision on
 * a `false` is "answer 400 and write nothing".
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (!header) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureMatches = signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf8');
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
  if (!signatureMatches) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  return ageSeconds <= toleranceSeconds;
}
