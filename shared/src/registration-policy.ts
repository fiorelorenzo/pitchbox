// Registration policy (#505): whether POST /api/auth/register accepts a
// registration at all, and if so, whether it needs a valid invite token.
// Three states, same convention as retention/quota/default-runner - a
// single instance-wide `app_config` row, read at request time so opening or
// closing a deployment needs no redeploy:
//
//   - 'open':   anyone can register, with or without an invite token.
//   - 'invite': a registration must carry a valid invite token.
//   - 'off':    no registration at all - accounts come from `seed:owner` or
//               the CLI.
//
// The code default is 'invite': a self-host operator turning
// `PITCHBOX_AUTH=on` is usually a single person making the app reachable,
// and a public registration form is the last thing they want by default. A
// deployment that wants open sign-up (the cloud edition) sets this
// explicitly through the instance-admin area - never the code default.

import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';

export type RegistrationPolicy = 'open' | 'invite' | 'off';

export const DEFAULT_REGISTRATION_POLICY: RegistrationPolicy = 'invite';

const APP_CONFIG_KEY = 'registration_policy';

export async function loadRegistrationPolicy(db: Db): Promise<RegistrationPolicy> {
  const [row] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, APP_CONFIG_KEY))
    .limit(1);
  const raw = (row?.value as { policy?: unknown } | undefined)?.policy;
  return raw === 'open' || raw === 'invite' || raw === 'off' ? raw : DEFAULT_REGISTRATION_POLICY;
}

export async function saveRegistrationPolicy(
  db: Db,
  policy: RegistrationPolicy,
): Promise<RegistrationPolicy> {
  const value = { policy };
  await db
    .insert(schema.appConfig)
    .values({ key: APP_CONFIG_KEY, value })
    .onConflictDoUpdate({ target: schema.appConfig.key, set: { value } });
  return policy;
}
