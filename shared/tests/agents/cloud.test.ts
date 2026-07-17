// Exercises resolveRunnerToken (shared/src/agents/cloud.ts): the WS handshake
// credential resolution the `cloud` runner uses at dispatch time (CLD-P1,
// docs/cloud-runner-productionization-design.md section 1). Mints via the real
// mintRunnerJwt (no mocking the signer), and asserts the static
// PITCHBOX_RUNNER_TOKEN fallback is used exactly when a JWT can't be minted.
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI, importSPKI, jwtVerify } from 'jose';
import { resolveRunnerToken } from '../../src/agents/cloud.js';
import { RUNNER_JWT_ALG } from '../../src/agents/cloud/jwt.js';

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair(RUNNER_JWT_ALG, { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
  publicKeyPem = await exportSPKI(publicKey);
});

afterEach(() => {
  delete process.env.RUNNER_JWT_PRIVATE_KEY;
  delete process.env.RUNNER_JWT_TTL_SECONDS;
  delete process.env.PITCHBOX_RUNNER_TOKEN;
});

describe('resolveRunnerToken', () => {
  it('mints a per-org JWT when a private key is configured and the org is known', async () => {
    process.env.RUNNER_JWT_PRIVATE_KEY = privateKeyPem;
    process.env.PITCHBOX_RUNNER_TOKEN = 'legacy-static-token';

    const token = await resolveRunnerToken(42);
    expect(token).not.toBe('legacy-static-token');

    const key = await importSPKI(publicKeyPem, RUNNER_JWT_ALG);
    const { payload } = await jwtVerify(token as string, key, { algorithms: [RUNNER_JWT_ALG] });
    expect(payload.org_id).toBe(42);
  });

  it('falls back to the static PITCHBOX_RUNNER_TOKEN when no private key is configured', async () => {
    process.env.PITCHBOX_RUNNER_TOKEN = 'legacy-static-token';
    await expect(resolveRunnerToken(42)).resolves.toBe('legacy-static-token');
    // Same fallback for a run with no resolved org, since there's no JWT to mint either way.
    await expect(resolveRunnerToken(undefined)).resolves.toBe('legacy-static-token');
  });

  it('falls back to the static token when a private key is configured but no org is known', async () => {
    process.env.RUNNER_JWT_PRIVATE_KEY = privateKeyPem;
    process.env.PITCHBOX_RUNNER_TOKEN = 'legacy-static-token';
    await expect(resolveRunnerToken(undefined)).resolves.toBe('legacy-static-token');
  });

  it('returns undefined when neither a private key nor a static token is configured', async () => {
    await expect(resolveRunnerToken(42)).resolves.toBeUndefined();
  });
});
