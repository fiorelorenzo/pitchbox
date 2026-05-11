# Authentication

Pitchbox ships unauthenticated by default for single-user self-host. Opt in with:

```bash
PITCHBOX_AUTH=on
```

When on, `hooks.server.ts` checks the `pitchbox_session` cookie on every non-exempt request:

- HTML navigations without a valid session → redirect to `/login?next=<path>`.
- `/api/*` calls without a valid session → `401 unauthenticated`.
- `/api/extension/*` and `/api/auth/*` remain exempt by design (the extension uses its own token).

## First-run bootstrap

If no user exists in the `users` table, the first POST to `/api/auth/login` creates that user with the credentials you submit. Subsequent logins verify credentials with scrypt against the `password_hash`.

## Sessions

`createSession()` mints a 32-byte hex token, stores it in the `sessions` table with a 30-day expiry, and sets it as an httpOnly cookie. `loadSession()` joins `sessions × users` and only returns non-expired rows. Logging out deletes the row and clears the cookie.

## What's deferred

Multi-tenant orgs, SSO providers, billing hooks, and the cloud/self-hosted edition flag are intentionally **not** part of this phase. The `users` + `sessions` tables are the foundation; future phases bolt orgs and memberships on top without breaking the cookie path.
