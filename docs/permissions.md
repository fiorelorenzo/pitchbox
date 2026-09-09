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
`run/[id]` DELETE, `notifications` POST, `settings/github-sources` GET.

**admin** (`requireRole(event, 'admin')`):
`campaigns/[id]` DELETE, `projects` POST, `projects/[id]` PATCH + DELETE,
`projects/[id]/accounts` POST, `projects/[id]/accounts/[accountId]` PATCH + DELETE,
`projects/[id]/recommendations/[recId]` DELETE,
`projects/[id]/templates/[templateId]` DELETE, `blocklist/[id]` DELETE,
`settings/extension-devices/[id]` DELETE,
`settings/extension-pairing` POST, `runners` POST, `playbooks` POST,
`playbooks/[id]` PATCH + DELETE,
`settings/default-runner` GET, `settings/quota` GET, `settings/runner-config` GET
(view only - saving these needs instance admin, see below),
`settings/linkedin-assist` GET + POST (org-scoped, unlike the instance-wide
settings above - the page's own loader also throws here, see the #254 note
below), `settings/companion` GET + the `saveProfile`/`toggleVoiceSample` form
actions (2026-09-07 companion decisions: the operator's persona and voice
samples that feed every suggestion's prompt are at least as sensitive as the
LinkedIn assist switch, so this page's loader throws the same way),
`settings/github-sources` POST + `[id]` DELETE (adding/removing a repo the
companion may cite; the GET is member-level, listed below, since reading it
back is no more sensitive than reading a project),
`orgs/[slug]/invites` POST, `orgs/[slug]/invites/[token]` DELETE,
`orgs/[slug]/members/[userId]` PATCH + DELETE (with the member-management rules).

**owner** (enforced inside the members endpoint logic): granting or revoking the
`owner` role.

## Instance admin

Distinct from the per-org roles above: `users.is_instance_admin` gates
instance-wide config shared by every tenant (default runner, quota defaults,
runner config, notification webhook, dead-letter webhook retry, per-function
model config). Any user can self-create an org via `POST /api/orgs` and
become its owner/admin, so the per-org `admin`/`owner` roles must never
grant access to this config - only `requireInstanceAdmin(event)`
(`web/src/lib/server/auth.ts`) does, checking the signed-in user's
`is_instance_admin` column. A no-op when auth is off (no `locals.user`),
same convention as `requireRole`. The first user (first-login bootstrap or
`seed:owner`) is always the instance admin. Every write to
`is_instance_admin` - the bootstrap grant and every promotion after it - goes
through the single `setInstanceAdmin` function (`shared/src/auth.ts`), so
there is exactly one place to audit for who can end up with the flag (#413).

`settings/default-runner` PUT, `settings/runner-config` PUT, `settings/quota`
POST, `settings/webhooks` PUT, `settings/model-functions` POST,
`webhooks/deliveries/[id]/retry` POST (also tenant-guarded: the delivery
must belong to the caller's org before the instance-admin gate runs),
`settings/retention` form action (saving only - viewing the page, and the
GET routes above, stay `requireRole(event, 'admin')`), `settings/admin/registration`
GET + POST (#505's registration policy switch - open/invite/off - surfaced on
`settings/admin` itself rather than a route of its own, since it is a single
value with no per-data-set split to justify one).

### Instance-wide audit trail (#414)

Every write listed above changes config shared by every organization, so it
cannot land in the org-scoped audit feed below (`draft_events`/`run_events`,
both reached through a project's `organization_id` - an instance-wide write
belongs to no project). `instance_audit_log` (`shared/src/db/schema.ts`) is
its own table for exactly that reason: `key`, `actor`, `before`, `after`,
`created_at`. `recordInstanceAudit` (`shared/src/instance-audit.ts`) is the
one function every route above calls after its write succeeds - a route
that forgets to call it is the only way this trail goes missing, rather than
each route recording it differently - and it redacts `before`/`after` itself
(any JSON field whose name looks like a credential, and any `*url` field,
which a webhook target can carry one inside), so a caller does not have to
remember to. Wired into default-runner, runner-config, quota, webhooks,
retention, model-functions, registration-policy, and the account-promotion
action (`web/src/routes/api/settings/admin/promote/+server.ts`, #413) -
every `requireInstanceAdmin`-gated write above records itself under key
`default_runner`, `runner_config:<slug>`, `quota_defaults`,
`notification_webhooks`, `retention`, `model_function:<fn>`,
`registration_policy`, or `user_promotion`. Rendered at `settings/admin/audit`
(gated the same way as every other page in the area below), most recent
first.

The redaction is a name-based heuristic, not a guarantee: it catches a
field named `key`/`token`/`secret`/`password`/`credential` (any case, any
substring) or ending in `url`, wherever it appears in `before`/`after`. A
future instance-wide setting whose sensitive value sits in a field matching
neither pattern - `gatewayAccount`, `smtpUser`, say - would land in the row
unredacted. Reading `redactInstanceAuditValue`'s doc comment
(`shared/src/instance-audit.ts`) once before adding a new instance-wide
write is the way to catch that, not an assumption that the function
guarantees safety on its own.

### Instance admin area (#412)

`settings/admin` is a small area of its own, separate from every org-scoped
settings route above: it gates on `requireInstanceAdmin(event)` (not
`requireRole`), so an org owner who is not the instance admin gets 403 from
a direct request the same as a member would. Unlike the rest of `settings/`
(each route above gates itself in its own loader), this gate lives once in
`web/src/routes/settings/admin/+layout.server.ts` rather than per page: the
area grew two sibling routes behind that one gate - `settings/admin/models`
(#411's per-function model configuration) and `settings/admin/audit` (#414's
instance-wide audit trail above) - without either needing to repeat the
check. `settings/admin` itself is a landing page that links out to the
instance-wide config that already lived on org-shaped pages before this area
existed - `runners`, `quota`, `retention`, and the outgoing webhook on
`/notifications` - plus its own `models` and `audit` pages; each of the
org-shaped ones keeps the write gate described above. With auth off,
`requireInstanceAdmin` is a no-op (no `locals.user`) the same way
`requireRole` is, so the lone self-host operator - who already owns every
organization on the instance - reaches this area too; that is a deliberate
reading of the no-op convention, not an oversight; it does not change while
auth is off.

The settings rail (`web/src/routes/settings/+layout.svelte`) shows an
"Instance admin" entry, visually separated from the organization-scoped
items above it by a divider and its own heading, only when
`data.isInstanceAdmin` (root `+layout.server.ts`, backed by the same
`isInstanceAdmin(event)` helper `requireInstanceAdmin` throws on) is true.
As with every other rail entry, hiding the link is presentation only - the
loaders above are the actual enforcement boundary.

### Promoting an instance admin (#413)

Before this, `is_instance_admin` could only ever be set at insert time: the
first-login bootstrap or `seed:owner`, or by hand in the database on a
deployment where the operator wasn't the first account to log in. `POST
/api/settings/admin/promote` closes that: it takes `{ userId }`, gates on
`requireInstanceAdmin(event)` like every other instance-wide write, and calls
`setInstanceAdmin(db, userId, true)` (`shared/src/auth.ts`) - the same
function `createUser` calls for the bootstrap grant, so there is exactly one
function that ever writes this column true rather than two write paths that
can drift apart. An allowlist read at login was the other option the issue
raised; it isn't built, because it would need its own environment-side
configuration on every deployment and either promote on every login forever
or need a second mechanism to stop after the first grant - the promote
action covers the same need with one write path and no standing
configuration. `settings/admin`'s page lists every user with their
instance-admin flag and a "Promote" button, so a promotion is visible from
the UI instead of the database; who promoted whom and when is recorded by
the instance audit trail above (#414), under key `user_promotion`.

The General settings page (four tabs behind one route) was flattened into
seven top-level routes, one flat rail with no tabs (#254): `settings/status`,
`settings/runners`, `settings/extension`, `settings/quota`,
`settings/organization`, `settings/retention`, `settings/security`. LI-19
(#316) later added an eighth, `settings/linkedin-assist` (the in-page
LinkedIn assistant's on/off switch, bound project, daily caps and kill
switch - org-scoped, so it throws `requireRole(event, 'admin')` like
Retention/Security rather than narrowing like Quota below); the 2026-09-07
companion decisions added a ninth, `settings/companion` (the operator's
persona, voice samples and GitHub sources that feed the assistant's prompt -
same org-scoped `requireRole(event, 'admin')` gate). #506 added a tenth,
`settings/password` (self-service password change for the signed-in caller -
gated on `locals.user` existing at all rather than an org role, since a
password change needs nothing beyond being the account holder; 404s when
auth is off, since there's no login concept and nothing to change a
password for). `/settings`
itself now just redirects (307) to `/settings/status`. The four routes that
used to be General's tabs each gate their own data set in their own loader,
the same per-data-set split #237 landed on the old combined page: `status`
(daemon health from a client store, plus the extension `backendUrl`, which is
not privileged) needs no role gate at all; `runners` (agent runner
detection/config, `settings/default-runner` + `settings/runner-config`
GET-equivalent data) and `quota` (posting quota defaults, `settings/quota`
GET-equivalent data) only populate their payload when `isAdmin` (per-org role
`admin`/`owner`, or no `locals.org` when auth is off); each route's
`+page.svelte` shows an "Admin access required" message instead of an
empty/misleading state when it isn't. `extension`'s paired-devices list
(`settings/extension-devices` GET) stays member-visible (read-only device
status); only revoking a device (DELETE) and minting a pairing code (POST
`settings/extension-pairing`) are admin-gated. The settings rail
(`web/src/routes/settings/+layout.svelte`) hides the `organization` link when
auth is off (no org context to show), and hides the `retention`/`security`/
`linkedin-assist`/`companion` links from a non-admin since those routes'
loaders call `requireRole(event, 'admin')` and would 403; `status`/`runners`/
`extension`/`quota`/`password` are always shown to a signed-in caller because
none of their loaders throw a role error (`password` still 404s with no
`locals.user`, i.e. auth off); they only narrow the payload or, for
`password`, gate on being signed in at all.

**Exempt** (no org role): `auth/*`, `extension/*` (token-auth companion),
`orgs` POST + `orgs/switch` POST (self-service), `orgs/[slug]/invites/[token]/accept`
POST (a new member joining, has no role yet).

Mixed-method files gate per method: `projects/[id]` (GET member / PATCH+DELETE
admin), `projects/[id]/templates/[templateId]` (PATCH member / DELETE admin),
`campaigns/[id]` (PATCH member / DELETE admin).

## UI

The layout exposes the active-org `role`; pages hide or disable admin-only
controls for members and surface a clear message on a 403. The API is the source
of truth: even if a control leaks through, the endpoint rejects it.
