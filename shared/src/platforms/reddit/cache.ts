import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, 'cache', 'http');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type Entry<T> = { fetchedAt: number; body: T };

function keyPath(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 20);
  return join(CACHE_DIR, `${hash}.json`);
}

export async function cacheGet<T>(key: string, ttlMs = DEFAULT_TTL_MS): Promise<T | null> {
  try {
    const raw = await readFile(keyPath(key), 'utf8');
    const entry = JSON.parse(raw) as Entry<T>;
    if (Date.now() - entry.fetchedAt > ttlMs) return null;
    return entry.body;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, body: T): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const entry: Entry<T> = { fetchedAt: Date.now(), body };
  await writeFile(keyPath(key), JSON.stringify(entry));
}
