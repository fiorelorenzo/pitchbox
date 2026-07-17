# Organization roles and permissions

Three per-organization roles, ranked: **member (1) < admin (2) < owner (3)**. A
user's role is the `memberships.role` for their active org, surfaced as
`locals.org.role`.

Enforcement is by `requireRole(event, minRole)` (`web/src/lib/server/auth.ts`):
it throws `error(403)` when the active-org role ranks below `minRole`. When auth
is off (`PITCHBOX_AUTH!=on`, single-user self-host) `locals.org` is unset and
`requireRole` is a no-op, so self-host keeps full access. It runs after the
tenant guards (`requireOrgId` + `*BelongsToOrg`), which stay in place.

## Capability model

- **member** = operator: does the day-to-day outreach work. Sees everything;
  creates/edits/runs campaigns; works drafts (approve/reject/send/regenerate/
  bulk); manages keyword watches; creates/edits templates; runs project
  extraction/insights; adds blocklist entries.
- **admin** = manager: everything a member can, plus structural and config work:
  projects (create/edit/delete), accounts and their credentials, deletes
  (templates, blocklist, recommendations), org settings, and member management.
- **owner** = proprietor: everything an admin can, plus owner management
  (granting/revoking the owner role). Admins can manage members but cannot touch
  owners or grant owner (no privilege escalation).

## Member management (A)

Owner/admin only (existing `isOrgAdmin`). Additional rules in the members
endpoints:

- An admin cannot remove or change the role of an **owner**, and cannot set a
  target's role to **owner**. Only an owner can grant/revoke owner.
- The org must always keep at least one owner: removing or demoting the **last
  owner** is rejected.
- No self-service via these endpoints (you cannot change your own role or remove
  yourself here); avoids accidental lockout.

## Route -> minimum role

Member-level routes need only org membership (no `requireRole`; the tenant guard
already limits them to the active org). Listed here for completeness.

**member** (no explicit role gate):
`campaigns` POST, `campaigns/[id]` PATCH, `campaigns/[id]/keyword-watches` *,
`campaigns/[id]/skill-runs` POST + `[runId]/adopt|discard` POST,
`drafts/bulk-approve` POST, `drafts/bulk-reschedule` POST, `drafts/[id]` PATCH,
`drafts/[id]/regenerate` (+ `/cancel`, `/undo`) POST,
`drafts/[id]/reply-draft/cancel|retry` POST, `inbox/[id]` PATCH (send),
`projects/[id]/runs` POST, `projects/[id]/insights` POST,
`projects/[id]/extraction-uploads` POST, `projects/[id]/templates` POST,
`projects/[id]/templates/[templateId]` PATCH, `blocklist` POST, `run` POST,
`run/[id]` DELETE, `notifications` POST.

**admin** (`requireRole(event, 'admin')`):
`projects` POST, `projects/[id]` PATCH + DELETE,
`projects/[id]/accounts` POST, `projects/[id]/accounts/[accountId]` PATCH + DELETE,
`projects/[id]/recommendations/[recId]` DELETE,
`projects/[id]/templates/[templateId]` DELETE, `blocklist/[id]` DELETE,
`settings/extension-devices/[id]` DELETE,
`settings/extension-pairing` POST, `runners` POST, `playbooks` POST,
`playbooks/[id]` PATCH + DELETE,
`orgs/[slug]/invites` POST, `orgs/[slug]/invites/[token]` DELETE,
`orgs/[slug]/members/[userId]` PATCH + DELETE (with the member-management rules).

**owner** (enforced inside the members endpoint logic): granting or revoking the
`owner` role.

## Instance admin

Distinct from the per-org roles above: `users.is_instance_admin` gates
instance-wide config shared by every tenant (default runner, quota defaults,
runner config, notification webhook, dead-letter webhook retry). Any user can
self-create an org via `POST /api/orgs` and become its owner/admin, so the
per-org `admin`/`owner` roles must never grant access to this config - only
`requireInstanceAdmin(event)` (`web/src/lib/server/auth.ts`) does, checking
the signed-in user's `is_instance_admin` column. A no-op when auth is off (no
`locals.user`), same convention as `requireRole`. The first user (first-login
bootstrap or `seed:owner`) is always the instance admin; nobody else is,
unless flipped directly in the database.

`settings/default-runner` PUT, `settings/runner-config` PUT, `settings/quota`
POST, `settings/webhooks` PUT, `webhooks/deliveries/[id]/retry` POST (also
tenant-guarded: the delivery must belong to the caller's org before the
instance-admin gate runs), `settings/retention` form action (saving only -
viewing the page stays `requireRole(event, 'admin')`).

**Exempt** (no org role): `auth/*`, `extension/*` (token-auth companion),
`orgs` POST + `orgs/switch` POST (self-service), `orgs/[slug]/invites/[token]/accept`
POST (a new member joining, has no role yet).

Mixed-method files gate per method: `projects/[id]` (GET member / PATCH+DELETE
admin), `projects/[id]/templates/[templateId]` (PATCH member / DELETE admin).

## UI

The layout exposes the active-org `role`; pages hide or disable admin-only
controls for members and surface a clear message on a 403. The API is the source
of truth: even if a control leaks through, the endpoint rejects it.
