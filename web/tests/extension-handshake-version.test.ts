import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as handshake } from '../src/routes/api/extension/handshake/+server.js';
import pkg from '../package.json';

/**
 * #379: the version came from `process.env.npm_package_version`, which is set
 * only when a package-manager script started the process. The deployed
 * container runs `node --import tsx` directly, so every real install saw the
 * `0.0.0` fallback and the extension's "Test connection" said "Connected -
 * server v0.0.0". A version that is only right in development is worse than
 * none: it is the field an operator uses to tell two deployments apart.
 */

async function reset() {
  await getDb().execute(sql`TRUNCATE extension_devices RESTART IDENTITY CASCADE`);
}

async function mintDevice(token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({
      organizationId: null,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      label: 'handshake test',
    });
}

function request(token: string): Request {
  return new Request('http://x/api/extension/handshake', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('POST /api/extension/handshake', () => {
  beforeEach(reset);

  it('reports the real deployed version, not a dev-only fallback', async () => {
    const token = 'handshake-token-1';
    await mintDevice(token);

    const res = await handshake({ request: request(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(pkg.version);
    expect(body.version).not.toBe('0.0.0');
  });

  it('still refuses a device that was never paired', async () => {
    await expect(handshake({ request: request('not-a-real-token') })).rejects.toThrow();
  });
});
