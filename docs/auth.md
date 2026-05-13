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

On a successful login the route **rotates the session id**: any existing session row matching the inbound cookie is deleted and a fresh id is minted before the cookie is set. This neutralises session-fixation attempts that try to pre-seed a known cookie value in the victim's browser.

## Rate-limit, lockout, and generic errors

`/api/auth/login` always returns the same `{ "error": "invalid_credentials" }` body with status `401` for both "user not found" and "wrong password" so an attacker can't probe for valid usernames.

Every failed attempt appends two rows to `auth_failures` - one keyed by `ip:<client-ip>` and one by `user:<submitted-username>`. If either bucket has at least `max_attempts` failures within `window_minutes`, further attempts return `429 { "error": "rate_limited", "retry_after_seconds": N }` until `lockout_minutes` have elapsed since the most recent failure. A successful login clears both buckets.

Policy lives in `app_config.auth_policy` (JSON). Defaults:

```json
{
  "max_attempts": 5,
  "window_minutes": 5,
  "lockout_minutes": 15
}
```

Override by inserting/updating that row directly - the login route reads it on each request, so changes take effect immediately.

## Security settings page

`/settings/security` lists the last 50 entries in `auth_failures` and exposes an **Unlock account** action that clears the `user:<username>` bucket via `POST /api/auth/unlock`. The IP bucket is not cleared by default - pass `{ "ip": "..." }` to clear that too.

## Organizations and memberships

The schema already carries `organizations` + `memberships`. On a fresh install a single `default` org is seeded, and the first user is auto-joined as `owner`. The data model is the same across editions - a single-org self-host is just a multi-tenant cloud install with one tenant.

`projects.organization_id` is the root tenant pointer; every other tenant-scoped row reaches the org through its project FK. Future phases tighten data access so server routes always filter by the caller's org membership.

## Edition flag and private submodule

`PITCHBOX_EDITION` switches between `self-hosted` (default) and `cloud`. Cloud-only code lives in a **private submodule** under `cloud/` (or `private/`) that the OSS repo never embeds - those paths are gitignored. Build tooling treats the submodule as optional: if absent, the OSS edition builds and runs unchanged; if present, cloud features are wired in at build time.

A `cloud` agent-runner adapter is already registered alongside `claude-code` / `codex` / `opencode`. In the OSS build it throws on instantiation with an actionable message; the real implementation ships from the private submodule.

## Phase 2: tenant isolation, invites, members

Phase 2 wires the multi-tenant model into the request pipeline:

- **Org middleware.** `web/src/hooks.server.ts` resolves the caller's primary org from `memberships` and stashes it on `event.locals.org = { id, slug, role }`. Authenticated requests with no membership return **404** (not 403) for any route outside `/login`, `/api/auth/*`, `/invite/*`, `/api/orgs/*`, and static. Returning 404 avoids leaking the existence of orgs the user can't see.
- **Scoped queries.** Server routes resolve `resolveOrgId(event)` and either filter directly (`projects.organization_id = $org`) or check via `projectBelongsToOrg` / `campaignBelongsToOrg` / `draftBelongsToOrg` from `@pitchbox/shared/orgs` before returning a row. The membership-aware helpers live in `shared/src/orgs.ts`.
- **Invites.** See [orgs.md](./orgs.md). `POST /api/orgs/[slug]/invites` (admin only) mints a single-use token; the invitee follows `/invite/<token>` (login if necessary) and a membership is created.

## What's deferred

Provider adapters beyond the local username/password flow (Google, magic-link, SSO), billing hooks, observability, and the per-org runner-quota layer are tracked as separate phases. Strict tenant scoping on every server route is in progress - today, scope is enforced where projects already mediate the query (most paths); a follow-up tightens the remaining edges.
