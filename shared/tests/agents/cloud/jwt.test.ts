// Exercises the client/control-plane side of the per-org runner-auth JWT
// (CLD-P1, docs/cloud-runner-productionization-design.md section 1): mint
// produces a token carrying the dispatching run's org_id, signed with the
// given private key and verifiable with the matching public key using the
// jose library directly (the same way the runner's own verify path does).
import { describe, expect, it, beforeAll } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI, importSPKI, jwtVerify } from 'jose';
import {
  mintRunnerJwt,
  RUNNER_JWT_ALG,
  type MintRunnerJwtOptions,
} from '../../../src/agents/cloud/jwt.js';
import {
  RUNNER_JWT_SCOPE,
  RUNNER_JWT_DEFAULT_TTL_SECONDS,
} from '../../../src/agents/cloud/protocol.js';

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair(RUNNER_JWT_ALG, { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
  publicKeyPem = await exportSPKI(publicKey);
});

async function verify(token: string, pem = publicKeyPem) {
  const key = await importSPKI(pem, RUNNER_JWT_ALG);
  return jwtVerify(token, key, { algorithms: [RUNNER_JWT_ALG] });
}

describe('mintRunnerJwt', () => {
  it('mints a token carrying org_id, verifiable with the matching public key', async () => {
    const token = await mintRunnerJwt({ orgId: 7, privateKeyPem });
    const { payload, protectedHeader } = await verify(token);

    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.org_id).toBe(7);
    expect(payload.scope).toBe(RUNNER_JWT_SCOPE);
    expect(typeof payload.jti).toBe('string');
    expect(payload.jti).not.toBe('');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('defaults the TTL to RUNNER_JWT_DEFAULT_TTL_SECONDS', async () => {
    const token = await mintRunnerJwt({ orgId: 1, privateKeyPem });
    const { payload } = await verify(token);
    expect((payload.exp as number) - (payload.iat as number)).toBe(RUNNER_JWT_DEFAULT_TTL_SECONDS);
  });

  it('honors a custom ttlSeconds', async () => {
    const token = await mintRunnerJwt({ orgId: 1, privateKeyPem, ttlSeconds: 30 });
    const { payload } = await verify(token);
    expect((payload.exp as number) - (payload.iat as number)).toBe(30);
  });

  it('mints a distinct jti per call (no accidental reuse across tokens)', async () => {
    const a = await mintRunnerJwt({ orgId: 1, privateKeyPem });
    const b = await mintRunnerJwt({ orgId: 1, privateKeyPem });
    const [{ payload: pa }, { payload: pb }] = await Promise.all([verify(a), verify(b)]);
    expect(pa.jti).not.toBe(pb.jti);
  });

  it('accepts a PEM with literal "\\n" escapes (as a single-line .env value stores it)', async () => {
    const escaped = privateKeyPem.replace(/\n/g, '\\n');
    const opts: MintRunnerJwtOptions = { orgId: 3, privateKeyPem: escaped };
    const token = await mintRunnerJwt(opts);
    const { payload } = await verify(token);
    expect(payload.org_id).toBe(3);
  });

  it('does not verify with an unrelated key pair (sanity check the fixture keys are distinct)', async () => {
    const other = await generateKeyPair(RUNNER_JWT_ALG, { extractable: true });
    const otherPublicPem = await exportSPKI(other.publicKey);
    const token = await mintRunnerJwt({ orgId: 1, privateKeyPem });
    await expect(verify(token, otherPublicPem)).rejects.toThrow();
  });
});
