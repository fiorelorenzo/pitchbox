// Mints the short-lived, per-org runner-auth JWT the client/control plane
// attaches to the WS handshake when dispatching a run to the cloud runner (see
// `RunnerJwtClaims` in ./protocol.js and
// docs/cloud-runner-productionization-design.md section 1). Uses `jose` for
// asymmetric (EdDSA/Ed25519) signing.
//
// This module is intentionally separate from protocol.ts, which must stay
// dependency-free so it vendors cleanly into the runner service repo via
// `pnpm sync:protocol`. The runner verifies with its own `jose` import against
// the matching public key; the two sides only share the claim shape.
import { SignJWT, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';
import { RUNNER_JWT_DEFAULT_TTL_SECONDS, RUNNER_JWT_SCOPE } from './protocol.js';

/** The only algorithm a runner-auth JWT is minted (and accepted) with. */
export const RUNNER_JWT_ALG = 'EdDSA';

export interface MintRunnerJwtOptions {
  /** The org the dispatching run belongs to; becomes the `org_id` claim. */
  orgId: number;
  /**
   * PKCS8 PEM Ed25519 private key (the `RUNNER_JWT_PRIVATE_KEY` env value).
   * Literal `\n` sequences - how a multi-line PEM commonly lands in a
   * single-line .env value - are normalized to real newlines.
   */
  privateKeyPem: string;
  /** Overrides `RUNNER_JWT_DEFAULT_TTL_SECONDS`. */
  ttlSeconds?: number;
}

/**
 * Sign a runner-auth JWT for `orgId`. The runner verifies it with the
 * matching public key and rejects the WS upgrade on a missing, invalid,
 * expired, wrong-key, or wrong-algorithm token - see cloud/runner's verify
 * path (`src/auth.ts`).
 */
export async function mintRunnerJwt(opts: MintRunnerJwtOptions): Promise<string> {
  const key = await importPKCS8(normalizePem(opts.privateKeyPem), RUNNER_JWT_ALG);
  const ttlSeconds = opts.ttlSeconds ?? RUNNER_JWT_DEFAULT_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ org_id: opts.orgId, scope: RUNNER_JWT_SCOPE })
    .setProtectedHeader({ alg: RUNNER_JWT_ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .setJti(randomUUID())
    .sign(key);
}

/** Un-escape literal `\n` sequences, as PEM values commonly land in a single-line env var. */
function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}
