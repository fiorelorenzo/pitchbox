# Authentication

Pitchbox ships unauthenticated by default for single-user self-host. Opt in with:

```bash
PITCHBOX_AUTH=on
```

When on, `hooks.server.ts` checks the `pitchbox_session` cookie on every non-exempt request:

- HTML navigations without a valid session → redirect to `/login?next=<path>` (or to `/register?next=<path>` for an `/invite/<token>` link - an invite is an account nobody has yet).
- `/api/*` calls without a valid session → `401 unauthenticated`.
- `/api/extension/*` is exempt by design - the extension authenticates with a per-device bearer token minted via `POST /api/extension/auto-pair` (which itself reads the dashboard session cookie). Only part of `/api/auth/*` is exempt, not the whole prefix: `login`, `logout`, `register`, `password/forgot` and `password/reset` have to be reachable with no session by definition. `password` (self-service change, below), `unlock` and `failures` stay behind session resolution like every other `/api/*` route - `/login`, `/register` and `/reset` (plus `/reset/<token>`) are exempt the same way on the HTML side.
- `POST /api/run` is not exempt, but has one narrow bypass for the daemon's own scheduled/keyword-triggered dispatch (`daemon/src/scheduler.ts`, `daemon/src/keyword-watcher.ts`), which carries no browser session and never will (#378). A request with no session cookie is still accepted there if it carries `Authorization: Bearer <PITCHBOX_INTERNAL_TOKEN>`, compared in constant time. The bypass only ever applies to that one route, only when there is no session, and only when `PITCHBOX_INTERNAL_TOKEN` is configured - unset (the default), the route stays exactly as closed as every other `/api/*` route. A session, when present, always takes priority.

## First-run bootstrap

On a brand-new install the `users` table is empty and the initial owner account is created the first time credentials are submitted to `POST /api/auth/login`; every later login then verifies with scrypt against the stored `password_hash`.

For any internet-facing deployment, claim the owner account (or seed it from deploy credentials) before the URL is reachable, so the initial account is never left unclaimed by an operator. Run `pitchbox seed:owner` right after migrations in the deploy pipeline: it reads `PITCHBOX_OWNER_USERNAME` and `PITCHBOX_OWNER_PASSWORD` from the environment and creates the owner (plus its default-org owner membership) through the same `createUser()` path the login bootstrap uses. It is a no-op (logs and exits 0) if a user already exists or either env var is unset, so it's safe to run on every deploy. This is the only way the _first_ account comes into existence; once one exists, Registration, an org invite, and the CLI below are the others.

## Registration

`POST /api/auth/register` (#504) creates an account with `username`,
`password` and `email` (required, unique on a normalized - trimmed,
lowercased - value, #507), plus an optional `token` when the visitor arrived
via `/invite/<token>`. Whether it succeeds at all is gated by a three-state,
instance-wide policy (#505, `shared/src/registration-policy.ts`,
`app_config.registration_policy`), read fresh on every call so a change from
Settings takes effect with no redeploy:

- `open` - anyone can register, with or without an invite token.
- `invite` - a registration must carry a valid invite token. **This is the
  code default**, and what a fresh deployment gets with nothing configured -
  a self-host operator turning `PITCHBOX_AUTH=on` is usually making the app
  reachable for themselves and their invitees, not the public.
- `off` - no registration at all; accounts come only from `seed:owner` or the
  CLI (see "Account recovery from the shell" below).

An instance admin changes it from `/settings/admin` (`GET`/`POST
/api/settings/admin/registration`, see [permissions.md](./permissions.md)) -
never the code default, which stays `invite`. A closed policy answers `403 {
"error": "registration_closed" }`; an invite-only policy with no token
answers `403 { "error": "invite_required" }`. `/register` itself reads the
same policy and hides the form rather than offering one that could only
fail, except when an invite token in the URL makes it valid anyway.

The route never goes through `createUser()`: that helper always joins the
single-tenant `default` org as owner, which would make every stranger who
registers an owner of it. Instead, in one transaction:

- **With a valid token**: the account is created and `acceptInvite` joins the
  inviting org with the invited role - never `default`, no org of its own.
- **With no token** (only reachable under `open`): the account gets its own
  single-owner organization, created by the same `createOrganization`
  primitive `POST /api/orgs` uses for a logged-in user's additional org
  (#513). Its slug derives from the username (already collected, already
  unique-ish for login), lowercased and collision-suffixed against
  `organizations.slug` rather than the email local part, which the registrant
  did not choose. The org starts with a default monthly run budget and
  concurrency cap from `app_config.org_quota_defaults` (#515) instead of the
  unlimited `null` every other column default gives - see
  [cloud-runner.md](cloud-runner.md) ("How cost and quota work"). The seeded
  `default` org and the `personal`-project convention ([orgs.md](orgs.md))
  are untouched by either branch above.

An invalid, expired, revoked or already-consumed token refuses the whole
registration (no account is created): `400 { "error":
"invalid_or_expired_invite" }`. A duplicate username or email returns `409 {
"error": "username_taken" | "email_taken" }`. Rate-limited by IP through the
same `auth_failures` table and policy as login. Login itself stays
username-only rather than accepting either username or email - password
recovery identifies people by address through its own route instead (below).

`/invite/<token>` sends a visitor with no session to `/register?next=...`
(not `/login`): an invite is an account nobody has yet.

## Password: change and reset

Two ways to end up with a new password, plus the CLI escape hatch below.

- **Self-service change** (#506, `POST /api/auth/password`,
  `/settings/password`) - the signed-in caller supplies their current and
  new password. It reuses the login route's rate-limit buckets, so a wrong
  current-password guess here throttles the same way a bad login attempt
  does. On success every _other_ session for the account is revoked; the one
  making the request stays alive.
- **Forgot / reset by email** (#509) - `POST /api/auth/password/forgot`
  takes an `email` and always answers `200 { "ok": true }` whether or not
  the address has an account, so the response can never be used to test
  which addresses exist. When it does, it mints a single-use token
  (20-minute expiry) and emails a `/reset/<token>` link through whatever
  mail transport is configured (see [self-hosting.md](./self-hosting.md) -
  the default sends nothing). `POST /api/auth/password/reset` redeems the
  token, sets the new password, and - unlike the self-service change -
  revokes _every_ session for the account, including the one making the
  request; the caller ends up signed in through a freshly minted session
  instead. Both routes are rate-limited by IP and by the submitted address,
  and both are exempt from session resolution the same way `/register` and
  `/login` are, since a locked-out visitor has none by definition.

Neither covers an account with no email on file - see "Account recovery from
the shell" below.

## Email verification

`users.email_verified_at` (#514) is null until the address is proven. A
registration mints a single-use, hashed-at-rest token
(`email_verification_tokens`, `createEmailVerificationToken`/
`consumeEmailVerificationToken` in `shared/src/auth.ts`, 48-hour TTL - hours
rather than the password-reset flow's 20 minutes, since people read mail
late) and mails a `/verify/<token>` link through the same transport
convention as password reset. Exactly one mail per registration, except one
case: an account created from an invite whose invite carried this exact
(normalized) address is born verified - the inviter already vouched for it -
and gets no mail at all. Changing the address on an existing account is not
implemented yet; when it lands, it must clear `email_verified_at` and
re-enter this flow rather than trust the new value untouched.

**Decision (recorded on #514): an unverified account can sign in and look
around, but cannot start a run.** A run spends real money through the AI
Gateway, and is the one action worth protecting from a throwaway signup -
everything else (browsing, settings, reading data) stays open. This is
enforced server-side, not by hiding a button: `requireVerifiedEmail`
(`web/src/lib/server/auth.ts`) throws `403 { "message": "email_unverified"
}` and is called at the top of every route that dispatches a run - `POST
/api/run`, `POST /api/campaigns` (which dispatches a skill-generation run on
creation), `POST /api/campaigns/[id]/skill-runs`, `POST
/api/projects/[id]/runs`, `POST /api/drafts/[id]/regenerate`, and `POST
/api/drafts/[id]/reply-draft/retry` - before any of them touch
`web/src/lib/server/runner.ts`. It is a no-op when there is no signed-in
caller (auth off, or the daemon's internal-token dispatch to `POST
/api/run`, which carries no session), same convention as `requireRole`. An
account with no email on file (a pre-#507 bootstrap/`seed:owner`/CLI
account, which can never clear this column) counts as verified - blocking it
would be a permanent lockout with no way out, not a spend protection.

`POST /api/auth/verify/confirm` redeems the token (rate-limited by IP,
unknown/used/expired all answer `400 { "error": "invalid_or_expired_token"
}` identically) and is exempt from session resolution like `/reset/<token>`,
since the link may be opened with no session at all. `POST
/api/auth/verify/resend` is session-gated (self-service, like `POST
/api/auth/password`) and rate-limited by IP and by the account's own address
through the same `auth_failures` bucket and `loadAuthPolicy` register and
login use; a caller who is already verified gets `{ "ok": true,
"alreadyVerified": true }` without touching the rate limit. `/settings/password`
shows the account's address, a Verified/Unverified badge, and the resend
button when unverified - the same per-account, signed-in-only surface the
self-service password change already uses.

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

## Account recovery from the shell

Forgot/reset by email (above) only covers an account with an address on
file, and only on a deployment with a real mail transport configured - the
default sends nothing. `pitchbox user:create <username> [--admin]`,
`pitchbox user:reset-password <username>`, and `pitchbox user:list` (see
`docs/cli.md`) cover the rest: an account made this way, from `seed:owner`,
or from the pre-#507 first-run bootstrap has no email at all (nothing in the
app can set one on an existing account), so it can never use the emailed
flow - the CLI is its only recovery path, permanently, not just until mail
is configured. Create an account, set a password, and grant instance-admin
are each an explicit action, not one magic command that does all three.
`user:create` and `user:reset-password` never accept a password as an
argument - `PITCHBOX_CLI_PASSWORD`, piped stdin, or an echo-suppressed
prompt only. `user:reset-password` deletes every one of that account's
sessions and clears its `auth_failures` bucket - the same mechanics `POST
/api/auth/password/reset` (the emailed reset link) uses, since neither has a
"this tab" session to spare the way the signed-in self-service change does.

## Organizations and memberships

The schema already carries `organizations` + `memberships`. On a fresh install a single `default` org is seeded, and the first user is auto-joined as `owner`. The data model is the same across editions - a single-org self-host is just a multi-tenant cloud install with one tenant.

`projects.organization_id` is the root tenant pointer; every other tenant-scoped row reaches the org through its project FK. Future phases tighten data access so server routes always filter by the caller's org membership.

## Edition flag and private submodule

`PITCHBOX_EDITION` switches between `self-hosted` (default) and `cloud`. A **private submodule** convention exists under `cloud/` (or `private/`, both gitignored) for cloud-only code the OSS repo never embeds, but nothing currently uses it: the cloud runner (below) needs no private code at all, and #420 retired the last thing that did (the ACP runner service's client adapter).

A `cloud` agent-runner is registered alongside `claude-code` / `codex` / `opencode`; unlike those it drives its model loop in-process against the Vercel AI Gateway (`AI_GATEWAY_API_KEY`) rather than spawning a local CLI - no private submodule required.

## Phase 2: tenant isolation, invites, members

Phase 2 wires the multi-tenant model into the request pipeline:

- **Org middleware.** `web/src/hooks.server.ts` resolves the caller's primary org from `memberships` and stashes it on `event.locals.org = { id, slug, role }`. Authenticated requests with no membership return **404** (not 403) for any route outside `/login`, `/api/auth/*`, `/invite/*`, `/api/orgs/*`, and static. Returning 404 avoids leaking the existence of orgs the user can't see.
- **Scoped queries.** Server routes resolve `resolveOrgId(event)` and either filter directly (`projects.organization_id = $org`) or check via `projectBelongsToOrg` / `campaignBelongsToOrg` / `draftBelongsToOrg` from `@pitchbox/shared/orgs` before returning a row. The membership-aware helpers live in `shared/src/orgs.ts`.
- **Invites.** See [orgs.md](./orgs.md). `POST /api/orgs/[slug]/invites` (admin only) mints a single-use token; the invitee follows `/invite/<token>` (login if necessary) and a membership is created.

## What's deferred

Provider adapters beyond the local username/password flow (Google, magic-link, SSO), billing hooks, observability, and the per-org runner-quota layer are tracked as separate phases. Strict tenant scoping on every server route is in progress - today, scope is enforced where projects already mediate the query (most paths); a follow-up tightens the remaining edges.
