import { Command } from 'commander';
import { getDb } from '@pitchbox/shared/db';
import { countUsers, createUser } from '@pitchbox/shared/auth';
import { ok } from '../lib/output.js';

export type SeedOwnerResult =
  | { created: true; userId: number; username: string }
  | { created: false; reason: 'user_exists' | 'env_missing' };

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
