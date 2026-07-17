import { Command } from 'commander';
import { z } from 'zod';
import { getDb } from '@pitchbox/shared/db';
import { countUsers, createUser } from '@pitchbox/shared/auth';
import { ok } from '../lib/output.js';

export type SeedOwnerResult =
  | { created: true; userId: number; username: string }
  | { created: false; reason: 'user_exists' | 'env_missing' }
  | { created: false; reason: 'invalid_username' | 'invalid_password'; message: string };

// Mirrors the `Body` schema in web/src/routes/api/auth/login/+server.ts, so a
// seeded owner always satisfies the same rules the login route enforces.
// Keep these in sync if either changes.
const OwnerUsername = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const OwnerPassword = z.string().min(8).max(256);

// Core logic, extracted from the commander action so it can be reused by both
// the `pitchbox` CLI and (if ever needed) the Pitchbox MCP server. Meant to
// run once, post-migrate, in the deploy pipeline: it closes the first-run
// claim window where an unauthenticated POST /api/auth/login on an empty
// users table would otherwise let anyone claim the owner account (see
// web/src/routes/api/auth/login/+server.ts).
//
// Reuses the same createUser() the login bootstrap uses, so hashing and the
// default-org owner membership never diverge between the two paths.
export async function seedOwner(): Promise<SeedOwnerResult> {
  const username = process.env.PITCHBOX_OWNER_USERNAME;
  const password = process.env.PITCHBOX_OWNER_PASSWORD;
  if (!username || !password) {
    return { created: false, reason: 'env_missing' };
  }

  // Validate before touching the DB: a user the login route would then always
  // reject is worse than no seeded user at all, since it looks claimed but
  // nobody can ever log into it.
  const usernameCheck = OwnerUsername.safeParse(username);
  if (!usernameCheck.success) {
    const message =
      'PITCHBOX_OWNER_USERNAME is invalid: must be 1-64 characters, letters/digits/"_"/"."/"-" only. Owner was not created.';
    console.error(`[seed:owner] ${message}`);
    return { created: false, reason: 'invalid_username', message };
  }
  const passwordCheck = OwnerPassword.safeParse(password);
  if (!passwordCheck.success) {
    const message =
      'PITCHBOX_OWNER_PASSWORD is invalid: must be 8-256 characters. Owner was not created.';
    console.error(`[seed:owner] ${message}`);
    return { created: false, reason: 'invalid_password', message };
  }

  const db = getDb();
  const total = await countUsers(db);
  if (total > 0) {
    return { created: false, reason: 'user_exists' };
  }

  const userId = await createUser(db, username, password);
  return { created: true, userId, username };
}

export function registerSeedCommands(program: Command) {
  program
    .command('seed:owner')
    .description(
      'Create the owner user (and default-org owner membership) from PITCHBOX_OWNER_USERNAME/PITCHBOX_OWNER_PASSWORD. No-op if a user already exists or either env var is unset.',
    )
    .action(async () => {
      ok(await seedOwner());
    });
}
