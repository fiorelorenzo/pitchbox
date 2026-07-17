// Exercises resolveRunnerToken (shared/src/agents/cloud.ts): the WS handshake
// credential resolution the `cloud` runner uses at dispatch time (CLD-P1,
// docs/cloud-runner-productionization-design.md section 1). Mints via the real
// mintRunnerJwt (no mocking the signer), and asserts the static
// PITCHBOX_RUNNER_TOKEN fallback is used exactly when a JWT can't be minted.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateKeyPair, exportPKCS8, exportSPKI, importSPKI, jwtVerify } from 'jose';
import { resolveRunnerToken } from '../../src/agents/cloud.js';
import { RUNNER_JWT_ALG } from '../../src/agents/cloud/jwt.js';
import { getDb, schema } from '../../src/db/client.js';
import * as orgQuota from '../../src/org-quota.js';

// Wraps the real getOrgQuotaSnapshot in a vi.fn so every other test in this
// file still exercises the real implementation (real DB reads), while the
// fail-closed test below can override it for a single call.
vi.mock('../../src/org-quota.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/org-quota.js')>();
  return { ...actual, getOrgQuotaSnapshot: vi.fn(actual.getOrgQuotaSnapshot) };
});

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

describe('resolveRunnerToken: quota claim (CLD-P5)', () => {
  const createdOrgIds: number[] = [];

  afterEach(async () => {
    const db = getDb();
    while (createdOrgIds.length > 0) {
      const id = createdOrgIds.pop()!;
      // Cascades to projects/runs (schema.ts: organizations -> projects -> runs
      // are all onDelete: 'cascade').
      await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
    }
  });

  async function verifyQuota(token: string | undefined) {
    const key = await importSPKI(publicKeyPem, RUNNER_JWT_ALG);
    const { payload } = await jwtVerify(token as string, key, { algorithms: [RUNNER_JWT_ALG] });
    return payload.quota;
  }

  it('mints a quota claim reflecting the org monthly budget and concurrency cap', async () => {
    process.env.RUNNER_JWT_PRIVATE_KEY = privateKeyPem;
    const db = getDb();
    const slug = `cloud-quota-test-${randomUUID()}`;
    const [org] = await db
      .insert(schema.organizations)
      .values({ slug, name: slug, monthlyRunBudgetUsd: '50.00', maxConcurrentRuns: 2 })
      .returning();
    createdOrgIds.push(org.id);

    const token = await resolveRunnerToken(org.id);
    expect(await verifyQuota(token)).toEqual({ remainingUsd: 50, concurrencyCap: 2 });
  });

  it('subtracts month-to-date run cost from the org budget', async () => {
    process.env.RUNNER_JWT_PRIVATE_KEY = privateKeyPem;
    const db = getDb();
    const slug = `cloud-quota-test-${randomUUID()}`;
    const [org] = await db
      .insert(schema.organizations)
      .values({ slug, name: slug, monthlyRunBudgetUsd: '50.00' })
      .returning();
    createdOrgIds.push(org.id);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p', name: 'p' })
      .returning();
    await db.insert(schema.runs).values({
      kind: 'project_extraction',
      projectId: project.id,
      trigger: 'manual',
      status: 'success',
      costUsd: '12.5000',
    });

    const token = await resolveRunnerToken(org.id);
    const quota = (await verifyQuota(token)) as {
      remainingUsd: number;
      concurrencyCap: number | null;
    };
    expect(quota.remainingUsd).toBeCloseTo(37.5, 4);
    expect(quota.concurrencyCap).toBeNull();
  });

  it('mints an explicit unlimited quota claim for an org with no budget/cap configured', async () => {
    process.env.RUNNER_JWT_PRIVATE_KEY = privateKeyPem;
    const db = getDb();
    const slug = `cloud-quota-test-${randomUUID()}`;
    const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
    createdOrgIds.push(org.id);

    const token = await resolveRunnerToken(org.id);
    expect(await verifyQuota(token)).toEqual({ remainingUsd: null, concurrencyCap: null });
  });
});

describe('resolveRunnerToken: fails closed on a quota-snapshot error (#156 review)', () => {
  afterEach(() => {
    vi.mocked(orgQuota.getOrgQuotaSnapshot).mockClear();
  });

  it('propagates a getOrgQuotaSnapshot failure instead of minting a token with no quota claim', async () => {
    process.env.RUNNER_JWT_PRIVATE_KEY = privateKeyPem;
    vi.mocked(orgQuota.getOrgQuotaSnapshot).mockRejectedValueOnce(new Error('db unavailable'));

    // Fail-closed: a quota-snapshot error must fail the mint, not fall
    // through to a token with no quota claim (which the runner would treat
    // as unenforced, letting an over-budget org run unmetered).
    await expect(resolveRunnerToken(42)).rejects.toThrow('db unavailable');
  });
});
