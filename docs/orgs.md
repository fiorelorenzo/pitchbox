# Organizations

Pitchbox supports multi-tenant orgs. On a fresh install a `default` org is seeded and the first user joins as `owner`. Every project, campaign, draft, run, account, and blocklist entry is scoped to an org through `projects.organization_id`.

## Roles

| Role     | Can invite | Can change roles | Can remove members | Notes               |
| -------- | ---------- | ---------------- | ------------------ | ------------------- |
| `owner`  | yes        | yes              | yes                | First user          |
| `admin`  | yes        | yes              | yes                | Same as owner today |
| `member` | no         | no               | no                 | Default invite role |

## Tenant scoping

The hook `handle` in `web/src/hooks.server.ts` runs `loadOrganizationForUser` on every authenticated request and either:

1. Sets `event.locals.org = { id, slug, role }` and continues, or
2. Returns **404** if the user has no membership (not 403 - we don't leak existence).

`/invite/*` and `/api/orgs/*` are exempt because a newly registered user with no membership still needs to accept an invite.

Server queries either filter `projects.organization_id` directly (e.g. `listProjects({ organizationId })`) or call one of the helpers in `@pitchbox/shared/orgs`:

- `projectBelongsToOrg(db, projectId, orgId)`
- `campaignBelongsToOrg(db, campaignId, orgId)`
- `draftBelongsToOrg(db, draftId, orgId)`
- `runBelongsToOrg(db, runId, orgId)`

Each returns `false` for cross-tenant access; the route then returns 404.

## Invite flow

1. **Admin generates a link**

   ```http
   POST /api/orgs/<slug>/invites
   Content-Type: application/json

   { "role": "member", "email": "alice@example.com" }
   ```

   Response:

   ```json
   {
     "token": "…48 hex chars…",
     "url": "https://.../invite/<token>",
     "expiresAt": "…ISO8601…"
   }
   ```

   The invite is valid for **7 days** and is single-use (the row is marked `accepted_at` once consumed).

2. **Invitee visits `/invite/<token>`**
   - Not logged in? Redirected to `/login?next=/invite/<token>`.
   - Logged in? The page server calls `acceptInvite`, creates a membership, and redirects to `/`.

3. **Programmatic accept**

   ```http
   POST /api/orgs/<slug>/invites/<token>/accept
   ```

   Same effect as visiting the page. Returns `{ organizationId, role }` or 404 if the token is invalid/expired/consumed.

## Organization management

`/settings/organization` (reached from the org switcher) is the org home: rename the org (admin+), a roles reference, the member list with role change and removal (owner/admin, owner-protected), pending invites with revoke, and a danger zone to leave the org (blocked for the sole owner) or delete it (owner, non-`default`, typed confirm). Roles are enforced server-side; see [permissions.md](permissions.md).

## Database

```
organizations         id, slug (unique), name
memberships           id, organization_id, user_id, role, created_at  (unique org+user)
org_invites           id, organization_id, token (unique), email, role,
                      expires_at, created_at, accepted_at, created_by_user_id
projects              … organization_id → organizations.id
```

Every other tenant-scoped table reaches the org through `projects.organization_id`.
