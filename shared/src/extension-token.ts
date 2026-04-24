import { randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client.js';
import { appConfig } from './db/schema.js';

const TOKEN_KEY = 'extension_api_token';
const CREATED_KEY = 'extension_token_created_at';

export async function getExtensionToken(): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, TOKEN_KEY));
  if (!row) return null;
  const value = row.value as unknown;
  return typeof value === 'string' ? value : null;
}

export async function getExtensionTokenCreatedAt(): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, CREATED_KEY));
  if (!row) return null;
  const value = row.value as unknown;
  return typeof value === 'string' ? value : null;
}

export async function rotateExtensionToken(): Promise<string> {
  const db = getDb();
  const token = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  await db
    .insert(appConfig)
    .values({ key: TOKEN_KEY, value: token })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: token } });
  await db
    .insert(appConfig)
    .values({ key: CREATED_KEY, value: now })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: now } });
  return token;
}

export async function verifyExtensionToken(candidate: string): Promise<boolean> {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const actual = await getExtensionToken();
  if (!actual) return false;
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
