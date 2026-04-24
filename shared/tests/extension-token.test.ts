import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema } from '../src/db/client.js';
import {
  getExtensionToken,
  rotateExtensionToken,
  verifyExtensionToken,
} from '../src/extension-token.js';

describe('extension-token', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(schema.appConfig);
  });

  it('returns null when no token is set', async () => {
    expect(await getExtensionToken()).toBeNull();
  });

  it('rotateExtensionToken creates a 64-hex-char token and persists it', async () => {
    const token = await rotateExtensionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await getExtensionToken()).toBe(token);
  });

  it('rotating replaces the old token', async () => {
    const a = await rotateExtensionToken();
    const b = await rotateExtensionToken();
    expect(a).not.toBe(b);
    expect(await getExtensionToken()).toBe(b);
  });

  it('verifyExtensionToken returns true for a matching token', async () => {
    const token = await rotateExtensionToken();
    expect(await verifyExtensionToken(token)).toBe(true);
  });

  it('verifyExtensionToken returns false for a wrong token', async () => {
    await rotateExtensionToken();
    expect(await verifyExtensionToken('deadbeef'.repeat(8))).toBe(false);
  });

  it('verifyExtensionToken returns false when no token is configured', async () => {
    expect(await verifyExtensionToken('deadbeef'.repeat(8))).toBe(false);
  });
});
