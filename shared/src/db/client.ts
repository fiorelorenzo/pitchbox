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
    // node-postgres emits 'error' on the pool for problems with idle clients
    // (e.g. a Postgres restart or network blip). Without a listener, that
    // event is unhandled and crashes the whole process - which would take
    // down the daemon (and web, when PITCHBOX_EMBED_DAEMON=1) on a transient
    // DB hiccup. Log it and let the pool recover instead.
    pool.on('error', (err) => {
      console.error('[db] unexpected error on idle pg client', err);
    });
  }
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export { schema };

export type Db = ReturnType<typeof getDb>;
