# Organization isolation: multi-org membership and enforced tenant boundaries

Status: approved design, ready for implementation planning
Date: 2026-07-10

## Summary

Pitchbox already has an organization-based multi-tenant model (`organizations`,
`memberships`, `users`) and projects already carry `organization_id` rather than
a per-user owner. What the user calls a "team" is this existing `organization`
concept. We keep the `organization` terminology in both the schema and the UI (no
rename).

The model is only half-wired today, so tenant isolation is not actually enforced:
the per-resource guard functions are dead code, a couple of list pages leak data
across orgs, by-id mutation routes fetch rows with no tenant check, and the code
assumes exactly one organization per user. This work completes the model:

1. A user can belong to multiple organizations and switch the active one.
2. Projects are always owned by an organization (enforced at the schema level).
3. Tenant isolation is real and applied consistently across the web layer.

Self-host compatibility is preserved: with `PITCHBOX_AUTH=off` (the current
production deployment) everything continues to resolve to the seeded `default`
organization, there is no switcher, and behaviour is unchanged.

## Current state (why this work is needed)

- `organizations` / `memberships` / `users` exist (`shared/src/db/schema.ts:30-60`).
  `memberships` is already many-to-many with a `role` column (`owner`/`admin`/
  `member`, plain text, typed as `OrgRole` in `shared/src/orgs.ts:17`).
- `projects.organization_id` exists but is **nullable** (`shared/src/db/schema.ts:127-138`),
  and `projects.slug` is **globally unique**.
- Tenant scoping is application-level (`WHERE organization_id = ...`), not RLS and
  not a scoped DB client. The DB client is a single shared pool
  (`shared/src/db/client.ts`).
- The guard helpers `projectBelongsToOrg` / `campaignBelongsToOrg` /
  `draftBelongsToOrg` / `runBelongsToOrg` (`shared/src/orgs.ts:26-72`) are called
  **only by tests** (`web/tests/org-isolation.test.ts`), not by any route.
- `loadOrganizationForUser` (`shared/src/auth.ts:210-226`) does `LIMIT 1`, i.e. the
  runtime assumes one org per user. `resolveOrgId` (`web/src/lib/server/auth.ts:17-32`)
  falls back to the `default` org when there is no session (self-host path).
- Two concrete leaks: `campaigns/+page.server.ts:34-37` and
  `inbox/+page.server.ts:58-61` only filter by the _selected project_, so with no
  project selected they return rows across all orgs. By-id routes such as
  `/api/drafts/[id]` and `/api/run` fetch by raw id with no tenant check.
- The auth/orgs feature is gated by `PITCHBOX_AUTH` (`web/src/hooks.server.ts:75`);
  default is `off`.

## Out of scope (YAGNI)

Explicitly not part of this work:

- Postgres Row-Level Security / a per-tenant scoped DB client.
- Scoping `contact_history` per organization (it stays global; see Residual risks).
- Re-validating injected ids inside the MCP/agent layer (the dispatch path already
  validates ownership before injecting them).
- A nested `organization -> team -> project` hierarchy. There is one tenant level.

## Design

### 1. Schema changes (Drizzle + migration)

Edit `shared/src/db/schema.ts`, then `pnpm run migrate:generate` and
`pnpm run migrate`. Do not hand-edit generated SQL.

1. **`sessions.active_organization_id`** — new nullable FK to `organizations`,
   `on delete set null`. Holds the org chosen via the switcher. When null, the
   active org falls back to the user's first membership.
2. **`projects.organization_id` becomes `NOT NULL`.** Migration backfills any
   null-org projects to the `default` organization first, then adds the constraint.
   This makes "a project always belongs to an organization" a schema invariant.
3. **Project slug becomes unique per organization.** Replace the global
   `unique(slug)` with `uniqueIndex(organization_id, slug)`. Every lookup of a
   project by slug alone becomes org-scoped (see section 5).
4. **`contact_history` is unchanged** (stays global). Recorded as a residual risk.

### 2. Active-organization resolution (session + switcher)

- Change org resolution so the active org is
  `session.active_organization_id` when the user has a valid membership for it,
  otherwise the user's first membership. Replace the `LIMIT 1` assumption in
  `shared/src/auth.ts:210-226` / the resolver in `web/src/lib/server/auth.ts` with a
  helper that (a) lists the user's memberships and (b) picks the active one, always
  validating that the user is a member of the active org. If the stored active org
  is no longer valid (membership removed), fall back to the first membership.
- The request hook (`web/src/hooks.server.ts:128-164`) keeps populating
  `locals.org = { id, slug, role }`, where `role` is the role for the _active_ org.
- **`POST /api/orgs/switch`** — body `{ organizationId }`. Verifies the user has a
  membership in the target org, writes `sessions.active_organization_id`, returns
  the new active org. Rejects with 403 if the user is not a member.
- **`POST /api/orgs`** — creates a new organization plus an `owner` membership for
  the caller, and switches the caller's active org to it. This is the minimum
  needed to actually have more than one org. Member invitations reuse the existing
  `org_invites` flow (`/invite`, `/api/orgs/[slug]/invites/*`).

### 3. Enforcement across the web layer

- **`requireOrgId(event)`** helper (in `web/src/lib/server/auth.ts`): returns the
  active org id or throws 401 (no session) / 404 (no membership). Every route that
  reads or mutates tenant data calls it first.
- **Wire the guards.** Call `projectBelongsToOrg` / `campaignBelongsToOrg` /
  `draftBelongsToOrg` / `runBelongsToOrg` (`shared/src/orgs.ts`) in every by-id
  route before reading or mutating the row, passing the active org id. Work through
  the routes grouped by resource (projects, campaigns, runs, drafts, accounts,
  templates, keyword watches, insights, blocklist) so coverage is systematic rather
  than ad hoc. A route that touches a resource whose ownership cannot be traced to
  an org (global tables) is exempt and documented as such.
- **Fix the leaking list pages.** `campaigns/+page.server.ts` and
  `inbox/+page.server.ts` must always constrain results to the active org's
  projects (join / `IN` against `projects` filtered by `organization_id`),
  independent of whether a project is selected. `listProjects(db, { organizationId })`
  (`shared/src/projects/projects.ts:31-61`) already takes the org, so project lists
  are the pattern to follow.
- **`/api/run`.** When the request carries a session, verify the active org owns
  the campaign (`campaignBelongsToOrg`) before calling `runCampaign`
  (`web/src/lib/server/runner.ts:395`). When the request is the daemon's internal
  call (no session, local backend, per `docs/daemon.md`), derive the org from the
  campaign itself and allow it, so the scheduler keeps working.
- **New-project creation** always sets `organization_id` to the active org; the
  active org is never chosen by the client.

### 4. MCP / agent boundary

Left trust-based, as scoped. It is covered transitively: the dispatch path now
validates that the active org owns the campaign before injecting
`PITCHBOX_PROJECT_ID` / `PITCHBOX_CAMPAIGN_ID` / `PITCHBOX_RUN_ID`
(`shared/src/agents/acp/runner.ts`), so an agent can never be handed an id from
another org. No `organizationId` is added to the MCP context
(`cli/src/mcp/server.ts:61-73`).

### 5. Slug lookups become org-scoped

Because project slugs are now unique per org rather than globally, any code path
that resolves a project by slug alone must take an org into account:

- CLI / MCP command logic that accepts a project slug resolves it within the
  session's org (or the `default` org when auth is off).
- Audit the call sites during implementation and thread the org through; a slug
  lookup with no org context resolves against the `default` org to preserve
  self-host behaviour.

### 6. UI

- Organization switcher in the sidebar: a dropdown listing the user's memberships;
  selecting one calls `POST /api/orgs/switch` and reloads.
- "Create organization" entry plus member/invite management, reusing the existing
  `/invite` surface and invite routes.
- Everything is gated behind `authOn` (`web/src/routes/+layout.server.ts`): with
  auth off the UI is identical to today (no switcher, single `default` org).
- All new user-facing strings are English, no em dashes (repo convention).

## Testing (TDD, real Postgres)

Tests hit the real `pitchbox_test` Postgres and run sequentially. Write/extend
tests before the implementation.

- Extend `web/tests/org-isolation.test.ts` from "the guards exist" to "each route
  category rejects cross-org access": for every resource, a member of org A cannot
  read or mutate a row owned by org B (expect 403/404).
- Multi-membership resolution: a user in orgs A and B resolves to the stored active
  org; an invalid stored active org falls back to the first membership.
- Switcher: `POST /api/orgs/switch` succeeds for a member, is rejected for a
  non-member, and persists across requests.
- Create org: `POST /api/orgs` creates the org, an `owner` membership, and switches
  the active org.
- List pages do not leak: with no project selected, campaigns and inbox return only
  the active org's rows.
- `/api/run` rejects a campaign owned by another org for a session caller, and still
  allows the daemon's internal call.
- Migration: the backfill assigns null-org projects to `default` and the
  `NOT NULL` + per-org unique slug constraints hold.

## Residual risks (accepted)

- **`contact_history` stays global.** Contact dedup is shared across orgs: one org
  can indirectly observe that another org has contacted a given user. Accepted for
  now; scoping it is future work.
- **MCP layer trusts injected ids.** Safe as long as dispatch keeps validating org
  ownership before injecting ids. If a new dispatch path is added, it must perform
  the same check.

## Rollout / compatibility

- With `PITCHBOX_AUTH=off` (current prod): active org is always `default`, no
  switcher, slug lookups resolve against `default`. No behavioural change.
- With `PITCHBOX_AUTH=on`: multi-org membership, switcher, and enforced isolation
  are active.
- The backfill migration is safe on the existing single-org production data (all
  projects already live under `default` or get assigned to it).
