import { config } from 'dotenv';
import { resolve } from 'node:path';
// Load .env from repo root (two levels up from shared/src/db/)
config({ path: resolve(import.meta.dirname, '../../..', '.env') });
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export { schema };

export type Db = ReturnType<typeof getDb>;
