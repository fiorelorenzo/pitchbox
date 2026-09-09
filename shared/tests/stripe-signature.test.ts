// verifyStripeSignature is the whole boundary the webhook route trusts
// before it ever reads the body as JSON or touches the database - every
// failure mode here must return false, never throw, and never make it
// look like an accident whether the signature or the timestamp failed.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyStripeSignature } from '../src/stripe/signature.js';

const SECRET = 'whsec_test_secret';

function sign(body: string, secret: string, timestamp: number): string {
  const signed = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${signed}`;
}

describe('verifyStripeSignature', () => {
  it('accepts a header computed with the right secret over the exact body', () => {
    const body = '{"id":"evt_1","type":"customer.subscription.updated"}';
    const header = sign(body, SECRET, Math.floor(Date.now() / 1000));
    expect(verifyStripeSignature(body, header, SECRET)).toBe(true);
  });

  it('rejects a body that does not match what was signed', () => {
    const signedBody = '{"id":"evt_1"}';
    const tamperedBody = '{"id":"evt_2"}';
    const header = sign(signedBody, SECRET, Math.floor(Date.now() / 1000));
    expect(verifyStripeSignature(tamperedBody, header, SECRET)).toBe(false);
  });

  it('rejects a header signed with the wrong secret', () => {
    const body = '{"id":"evt_1"}';
    const header = sign(body, 'whsec_wrong_secret', Math.floor(Date.now() / 1000));
    expect(verifyStripeSignature(body, header, SECRET)).toBe(false);
  });

  it('rejects a stale timestamp outside the tolerance window', () => {
    const body = '{"id":"evt_1"}';
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes old
    const header = sign(body, SECRET, staleTimestamp);
    expect(verifyStripeSignature(body, header, SECRET, 300)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyStripeSignature('{}', null, SECRET)).toBe(false);
  });

  it('rejects a header with no v1 entry', () => {
    const header = `t=${Math.floor(Date.now() / 1000)}`;
    expect(verifyStripeSignature('{}', header, SECRET)).toBe(false);
  });

  it('accepts when a rotated secret adds a second v1 entry and only the new one matches', () => {
    const body = '{"id":"evt_1"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const oldSig = sign(body, 'whsec_old_secret', timestamp).split(',v1=')[1];
    const newHeader = sign(body, SECRET, timestamp);
    const combined = `${newHeader},v1=${oldSig}`;
    expect(verifyStripeSignature(body, combined, SECRET)).toBe(true);
  });
});
