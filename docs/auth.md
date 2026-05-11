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

## Organizations and memberships

The schema already carries `organizations` + `memberships`. On a fresh install a single `default` org is seeded, and the first user is auto-joined as `owner`. The data model is the same across editions — a single-org self-host is just a multi-tenant cloud install with one tenant.

`projects.organization_id` is the root tenant pointer; every other tenant-scoped row reaches the org through its project FK. Future phases tighten data access so server routes always filter by the caller's org membership.

## Edition flag and private submodule

`PITCHBOX_EDITION` switches between `self-hosted` (default) and `cloud`. Cloud-only code lives in a **private submodule** under `cloud/` (or `private/`) that the OSS repo never embeds — those paths are gitignored. Build tooling treats the submodule as optional: if absent, the OSS edition builds and runs unchanged; if present, cloud features are wired in at build time.

A `cloud` agent-runner adapter is already registered alongside `claude-code` / `codex` / `opencode`. In the OSS build it throws on instantiation with an actionable message; the real implementation ships from the private submodule.

## What's deferred

Provider adapters beyond the local username/password flow (Google, magic-link, SSO), billing hooks, observability, and the per-org runner-quota layer are tracked as separate phases. Strict tenant scoping on every server route is in progress — today, scope is enforced where projects already mediate the query (most paths); a follow-up tightens the remaining edges.
