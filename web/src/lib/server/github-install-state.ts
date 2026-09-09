/**
 * The `state` parameter carried through a GitHub App installation (#390).
 *
 * GitHub redirects to the app's setup URL after an install with
 * `?installation_id=<n>&setup_action=install`, and it round-trips whatever
 * `state` the install URL carried. Neither value is trustworthy on arrival:
 * both are query parameters on a GET anybody can construct, so the callback
 * verifies the installation against GitHub with the app JWT
 * (`fetchInstallation`) and verifies this state's signature before it writes a
 * row.
 *
 * What the state buys, given the callback also requires a session: it pins the
 * install to the **organization that started it**. Without it, a person who
 * belongs to two organizations could start an install while acting for one and
 * land the row on whichever org their session happens to have active by the
 * time GitHub redirects back, which is a cross-tenant write nobody would ever
 * notice.
 *
 * Signed with `ENCRYPTION_KEY`, the deployment secret that already exists,
 * through an HMAC rather than the reversible `encrypt`/`decrypt` in
 * `shared/src/crypto.ts`: nothing here is secret (an org id and a nonce), only
 * unforgeable. Compared in constant time, and short-lived, because a state is
 * only ever in flight for as long as somebody takes to click Install.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Long enough for the GitHub flow, including choosing repositories on a
 * slow page, short enough that a link left in a browser history is useless. */
export const INSTALL_STATE_TTL_MS = 30 * 60 * 1000;

type StatePayload = { orgId: number; userId: number; nonce: string; exp: number };

function hmacKey(): string {
  const key = process.env.ENCRYPTION_KEY?.trim();
  if (!key) {
    // The app refuses to boot without ENCRYPTION_KEY elsewhere too; failing
    // loudly here beats signing with an empty key.
    throw new Error('[github-install] ENCRYPTION_KEY is not set, cannot sign an install state');
  }
  return key;
}

function sign(body: string): string {
  return createHmac('sha256', hmacKey()).update(body).digest('base64url');
}

export function encodeInstallState(orgId: number, userId: number, now: Date = new Date()): string {
  const payload: StatePayload = {
    orgId,
    userId,
    nonce: randomBytes(12).toString('base64url'),
    exp: now.getTime() + INSTALL_STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export type DecodedInstallState =
  | { ok: true; orgId: number; userId: number }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function decodeInstallState(
  state: string | null,
  now: Date = new Date(),
): DecodedInstallState {
  if (!state) return { ok: false, reason: 'malformed' };
  const [body, signature] = state.split('.');
  if (!body || !signature) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.orgId !== 'number' || typeof payload.userId !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (!Number.isFinite(payload.exp) || payload.exp < now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, orgId: payload.orgId, userId: payload.userId };
}
