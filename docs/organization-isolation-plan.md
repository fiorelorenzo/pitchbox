# Organization Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Pitchbox's organization-based multi-tenancy so a user can belong to multiple organizations, switch the active one, and every web route enforces per-organization isolation.

**Architecture:** The `organization` is the tenant (kept as-is, no rename). Projects are owned by an organization; all other tenant data hangs off `projects` via `project_id`. The active organization is stored on the session row and resolved in the request hook. Isolation is enforced application-side by calling the existing `*BelongsToOrg` guards (today dead code) on every by-id route, fixing the list pages that leak, and adding a tenant check to run dispatch.

**Tech Stack:** SvelteKit 2 / Svelte 5, Drizzle ORM + Postgres 16, Drizzle Kit migrations, Vitest against a real `pitchbox_test` Postgres (port 5434), pnpm workspaces.

## Global Constraints

- Node >= 22, pnpm 9.15. DB access only through `@pitchbox/shared` (never an ad-hoc `pg` client).
- Tests hit real Postgres `pitchbox_test`; `fileParallelism` stays disabled; run sequentially.
- Migrations: edit `shared/src/db/schema.ts`, run `pnpm run migrate:generate`, then `pnpm run migrate`. Do not hand-edit generated DDL; a data-backfill line inserted before a `SET NOT NULL` is the one allowed exception (it is not DDL and cannot be generated).
- English everywhere in code comments and UI strings. No em dashes (use hyphens/colons).
- `PITCHBOX_AUTH=off` (current production) must keep behaving exactly as today: single `default` org, no switcher, no new gates.
- Verify with `pnpm run lint`, `pnpm run typecheck`, `pnpm -F web check`, `pnpm test` before claiming done.

## Terminology and IDs used across tasks

- Active org resolution helper: `loadActiveOrganization(db, userId, preferredOrgId?)` returns `{ id, slug, role } | null`.
- Membership listing: `listUserOrganizations(db, userId)` returns `{ id, slug, name, role }[]`.
- Org creation: `createOrganization(db, { slug, name, ownerUserId })` returns `{ id, slug, role }`.
- Session active org: `setSessionActiveOrg(db, sessionId, organizationId)`; `loadSession` also returns `activeOrganizationId`.
- Web guards: `requireOrgId(event): Promise<number>` (throws 404 if unresolved); then one of `projectBelongsToOrg` / `campaignBelongsToOrg` / `draftBelongsToOrg` / `runBelongsToOrg` (all in `@pitchbox/shared/orgs`, signature `(db, id, orgId) => Promise<boolean>`).

## Known limitations carried by this plan (intentional, per the design)

- `contact_history` stays global (shared dedup across orgs).
- `/api/extension/*` routes are token-authenticated single-tenant surfaces (the Chrome companion) and are NOT org-guarded here.
- Global `blocklist` rows (`project_id IS NULL`) are a shared resource like `contact_history`; only project-scoped blocklist rows are org-guarded.
- The MCP/agent layer stays trust-based; it is covered because dispatch validates org ownership before injecting ids.

---

## File structure

- `shared/src/db/schema.ts` — modify `sessions`, `projects`.
- `shared/src/db/migrations/*.sql` — one generated migration (with a hand-inserted backfill line).
- `shared/src/orgs.ts` — add `listUserOrganizations`, `loadActiveOrganization`, `createOrganization`.
- `shared/src/auth.ts` — extend `loadSession`, add `setSessionActiveOrg`.
- `web/src/hooks.server.ts` — resolve active org from the session.
- `web/src/lib/server/auth.ts` — add `requireOrgId`.
- `web/src/routes/api/orgs/switch/+server.ts` — new.
- `web/src/routes/api/orgs/+server.ts` — new (create org).
- `web/src/routes/api/**` — insert guards into the by-id routes listed per task.
- `web/src/routes/campaigns/+page.server.ts`, `web/src/routes/inbox/+page.server.ts`, `web/src/routes/api/analytics/funnel/+server.ts`, `web/src/routes/api/export/[resource]/+server.ts` — scope reads to the active org.
- `web/src/routes/+layout.server.ts`, `web/src/lib/components/Sidebar.svelte` — org switcher UI.
- Tests under `web/tests/*.test.ts`.

---

## Task 1: Schema and migration (active org, org-owned projects, per-org slug)

**Files:**
- Modify: `shared/src/db/schema.ts` (`sessions` at 84-97, `projects` at 127-138)
- Create: `shared/src/db/migrations/<generated>.sql`
- Test: `web/tests/org-schema.test.ts`

**Interfaces:**
- Produces: `sessions.active_organization_id` (nullable FK), `projects.organization_id` NOT NULL, unique index `projects_org_slug_unique (organization_id, slug)`.

- [ ] **Step 1: Write the failing test**

Create `web/tests/org-schema.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE projects RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

describe('project org constraints', () => {
  beforeEach(reset);

  it('allows the same project slug in two different orgs', async () => {
    const db = getDb();
    const [a] = await db.insert(schema.organizations).values({ slug: 'sc-a', name: 'A' }).returning();
    const [b] = await db.insert(schema.organizations).values({ slug: 'sc-b', name: 'B' }).returning();
    await db.insert(schema.projects).values({ organizationId: a.id, slug: 'dup', name: 'dup A' });
    await expect(
      db.insert(schema.projects).values({ organizationId: b.id, slug: 'dup', name: 'dup B' }),
    ).resolves.toBeDefined();
  });

  it('rejects a duplicate project slug within the same org', async () => {
    const db = getDb();
    const [a] = await db.insert(schema.organizations).values({ slug: 'sc-c', name: 'C' }).returning();
    await db.insert(schema.projects).values({ organizationId: a.id, slug: 'same', name: 'one' });
    await expect(
      db.insert(schema.projects).values({ organizationId: a.id, slug: 'same', name: 'two' }),
    ).rejects.toThrow();
  });

  it('rejects a project with no organization', async () => {
    const db = getDb();
    await expect(
      // Cast: after NOT NULL the TS type requires organizationId; this is the negative case.
      db.insert(schema.projects).values({ slug: 'orphan', name: 'orphan' } as never),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/org-schema.test.ts`
Expected: FAIL. "allows the same project slug in two different orgs" rejects (slug is globally unique today), and "rejects a project with no organization" resolves instead of throwing (column is nullable today).

- [ ] **Step 3: Edit the schema**

In `shared/src/db/schema.ts`, change `sessions` to add the active-org column (insert after the `userId` FK, before `expiresAt`):

```ts
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activeOrganizationId: integer('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index('sessions_user_idx').on(t.userId),
  }),
);
```

Change `projects` to make the org required and the slug unique per org (note: `.notNull()` added, `.unique()` removed from `slug`, and the table gains a second callback arg):

```ts
export const projects = pgTable(
  'projects',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    defaultAgentRunner: text('default_agent_runner').notNull().default('claude-code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgSlugUnique: uniqueIndex('projects_org_slug_unique').on(t.organizationId, t.slug),
  }),
);
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm run migrate:generate`
Expected: a new file appears under `shared/src/db/migrations/`. Open it. It should contain (order may vary): `ALTER TABLE "sessions" ADD COLUMN "active_organization_id" integer;` + its FK, `DROP` of the old `projects_slug_unique`, `CREATE UNIQUE INDEX "projects_org_slug_unique" ...`, and `ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;`.

- [ ] **Step 5: Insert the backfill before the NOT NULL**

In the generated SQL file, immediately BEFORE the line `ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;`, insert:

```sql
--> statement-breakpoint
UPDATE "projects" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'default') WHERE "organization_id" IS NULL;
```

This assigns any legacy null-org project to the `default` org so the NOT NULL constraint holds. On the test DB there are no such rows; on production the `default` org exists.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run web/tests/org-schema.test.ts`
Expected: PASS (global-setup applies the new migration before the test runs). If "rejects a duplicate project slug within the same org" fails, confirm the old `.unique()` was removed from `slug`.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm run typecheck`
Expected: PASS.

```bash
git add shared/src/db/schema.ts shared/src/db/migrations web/tests/org-schema.test.ts
git commit -m "feat(db): active-org column, org-owned projects, per-org project slug"
```

---

## Task 2: Shared active-org resolution helpers

**Files:**
- Modify: `shared/src/orgs.ts`
- Test: `web/tests/active-org.test.ts`

**Interfaces:**
- Consumes: `organizations`, `memberships` from schema (already imported in `orgs.ts`).
- Produces:
  - `listUserOrganizations(db, userId): Promise<{ id: number; slug: string; name: string; role: string }[]>`
  - `loadActiveOrganization(db, userId, preferredOrgId?: number | null): Promise<{ id: number; slug: string; role: string } | null>`
  - `createOrganization(db, { slug, name, ownerUserId }): Promise<{ id: number; slug: string; role: string }>`

- [ ] **Step 1: Write the failing test**

Create `web/tests/active-org.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  listUserOrganizations,
  loadActiveOrganization,
  createOrganization,
} from '@pitchbox/shared/orgs';

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE projects RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedUser(username: string) {
  const [u] = await getDb().insert(schema.users).values({ username, passwordHash: 'x' }).returning();
  return u.id;
}
async function seedOrgMember(slug: string, userId: number, role = 'member') {
  const db = getDb();
  const [o] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  await db.insert(schema.memberships).values({ organizationId: o.id, userId, role });
  return o.id;
}

describe('active-org resolution', () => {
  beforeEach(reset);

  it('lists all organizations a user belongs to', async () => {
    const uid = await seedUser('u1');
    const a = await seedOrgMember('ao-a', uid, 'owner');
    const b = await seedOrgMember('ao-b', uid, 'member');
    const orgs = await listUserOrganizations(getDb(), uid);
    expect(orgs.map((o) => o.id).sort()).toEqual([a, b].sort());
    expect(orgs.find((o) => o.id === a)?.role).toBe('owner');
  });

  it('returns the preferred org when the user is a member', async () => {
    const uid = await seedUser('u2');
    await seedOrgMember('ao-c', uid);
    const b = await seedOrgMember('ao-d', uid);
    const org = await loadActiveOrganization(getDb(), uid, b);
    expect(org?.id).toBe(b);
  });

  it('falls back to the first org when the preferred org is not a membership', async () => {
    const uid = await seedUser('u3');
    const a = await seedOrgMember('ao-e', uid);
    const org = await loadActiveOrganization(getDb(), uid, 999999);
    expect(org?.id).toBe(a);
  });

  it('returns null when the user has no membership', async () => {
    const uid = await seedUser('u4');
    expect(await loadActiveOrganization(getDb(), uid, null)).toBeNull();
  });

  it('creates an org with an owner membership', async () => {
    const uid = await seedUser('u5');
    const org = await createOrganization(getDb(), { slug: 'ao-new', name: 'New', ownerUserId: uid });
    expect(org.role).toBe('owner');
    const orgs = await listUserOrganizations(getDb(), uid);
    expect(orgs.some((o) => o.id === org.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/active-org.test.ts`
Expected: FAIL with import errors ("listUserOrganizations is not a function" / not exported).

- [ ] **Step 3: Implement the helpers**

Append to `shared/src/orgs.ts` (the `organizations` and `memberships` imports and the `Db` type already exist at the top of the file):

```ts
export async function listUserOrganizations(
  db: Db,
  userId: number,
): Promise<{ id: number; slug: string; name: string; role: string }[]> {
  return db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(eq(memberships.userId, userId))
    .orderBy(organizations.id);
}

export async function loadActiveOrganization(
  db: Db,
  userId: number,
  preferredOrgId?: number | null,
): Promise<{ id: number; slug: string; role: string } | null> {
  const rows = await db
    .select({ id: organizations.id, slug: organizations.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(eq(memberships.userId, userId))
    .orderBy(organizations.id);
  if (rows.length === 0) return null;
  if (preferredOrgId != null) {
    const match = rows.find((r) => r.id === preferredOrgId);
    if (match) return match;
  }
  return rows[0];
}

export async function createOrganization(
  db: Db,
  args: { slug: string; name: string; ownerUserId: number },
): Promise<{ id: number; slug: string; role: string }> {
  const [org] = await db
    .insert(organizations)
    .values({ slug: args.slug, name: args.name })
    .returning();
  await db
    .insert(memberships)
    .values({ organizationId: org.id, userId: args.ownerUserId, role: 'owner' })
    .onConflictDoNothing();
  return { id: org.id, slug: org.slug, role: 'owner' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run web/tests/active-org.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/orgs.ts web/tests/active-org.test.ts
git commit -m "feat(orgs): multi-org membership listing, active-org resolution, org creation"
```

---

## Task 3: Session-stored active org

**Files:**
- Modify: `shared/src/auth.ts` (`loadSession` at 156-171; add `setSessionActiveOrg`)
- Test: `web/tests/session-active-org.test.ts`

**Interfaces:**
- Consumes: `sessions.activeOrganizationId` (from Task 1).
- Produces:
  - `loadSession` return extended to `{ userId, username, activeOrganizationId: number | null }`.
  - `setSessionActiveOrg(db, sessionId: string, organizationId: number): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `web/tests/session-active-org.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { createSession, loadSession, setSessionActiveOrg } from '@pitchbox/shared/auth';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

describe('session active org', () => {
  beforeEach(reset);

  it('starts with a null active org and stores a chosen one', async () => {
    const db = getDb();
    const [u] = await db.insert(schema.users).values({ username: 'sa', passwordHash: 'x' }).returning();
    const [o] = await db.insert(schema.organizations).values({ slug: 'sa-o', name: 'O' }).returning();
    const s = await createSession(db, u.id);

    const before = await loadSession(db, s.id);
    expect(before?.activeOrganizationId).toBeNull();

    await setSessionActiveOrg(db, s.id, o.id);
    const after = await loadSession(db, s.id);
    expect(after?.activeOrganizationId).toBe(o.id);
    expect(after?.username).toBe('sa');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/session-active-org.test.ts`
Expected: FAIL ("setSessionActiveOrg is not a function", and `activeOrganizationId` undefined on the load result).

- [ ] **Step 3: Extend `loadSession` and add `setSessionActiveOrg`**

In `shared/src/auth.ts`, change `loadSession` to also select the active org:

```ts
export async function loadSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  id: string,
): Promise<{ userId: number; username: string; activeOrganizationId: number | null } | null> {
  const rows = await db
    .select({
      userId: sessions.userId,
      username: users.username,
      activeOrganizationId: sessions.activeOrganizationId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}
```

Add, right after `deleteSession` (around line 179):

```ts
export async function setSessionActiveOrg(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  sessionId: string,
  organizationId: number,
): Promise<void> {
  await db.update(sessions).set({ activeOrganizationId: organizationId }).where(eq(sessions.id, sessionId));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run web/tests/session-active-org.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/auth.ts web/tests/session-active-org.test.ts
git commit -m "feat(auth): store and read the active organization on the session"
```

---

## Task 4: Hook resolves the active org; add `requireOrgId`

**Files:**
- Modify: `web/src/hooks.server.ts` (imports at 1-3; enforcement block at 128-164)
- Modify: `web/src/lib/server/auth.ts` (add `requireOrgId`)
- Test: `web/tests/require-org.test.ts`

**Interfaces:**
- Consumes: `loadActiveOrganization` (Task 2), `loadSession` extended (Task 3).
- Produces: `requireOrgId(event: RequestEvent): Promise<number>` (throws `error(404)` if no org resolves).

- [ ] **Step 1: Update the hook**

In `web/src/hooks.server.ts`, change the import on line 3 to add `loadActiveOrganization` (keep `loadSession`):

```ts
import { loadSession } from '@pitchbox/shared/auth';
import { loadActiveOrganization } from '@pitchbox/shared/orgs';
```

Remove `loadOrganizationForUser` from the `@pitchbox/shared/auth` import if it is no longer used elsewhere in the file. Then in the enforcement block replace the `loadOrganizationForUser` call (currently line ~152):

```ts
    const org = await loadActiveOrganization(
      getDb(),
      session.userId,
      session.activeOrganizationId ?? null,
    );
    if (org) {
      event.locals.org = org;
    } else if (!orgExempt) {
```

(The rest of the block, including the 404 branch, is unchanged.)

- [ ] **Step 2: Add `requireOrgId`**

In `web/src/lib/server/auth.ts`, add the import and helper:

```ts
import { error, type RequestEvent } from '@sveltejs/kit';
```

```ts
/**
 * Resolve the active organization id or fail the request. Use this at the top of
 * every route that reads or mutates tenant-scoped data. With auth off it returns
 * the default org, preserving single-tenant self-host behaviour.
 */
export async function requireOrgId(event: RequestEvent): Promise<number> {
  const orgId = await resolveOrgId(event);
  if (orgId == null) throw error(404, 'not_found');
  return orgId;
}
```

(Note: `RequestEvent` is already imported as a type on line 2; merge the named imports so `error` and `RequestEvent` come from `@sveltejs/kit` in one statement.)

- [ ] **Step 3: Write the test**

Create `web/tests/require-org.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { requireOrgId } from '../src/lib/server/auth.js';

function fakeEvent(org?: { id: number; slug: string; role: string }): RequestEvent {
  return { locals: { org }, request: new Request('http://x/') } as unknown as RequestEvent;
}

describe('requireOrgId', () => {
  it('returns the active org id from locals', async () => {
    const id = await requireOrgId(fakeEvent({ id: 42, slug: 's', role: 'owner' }));
    expect(id).toBe(42);
  });

  it('falls back to the default org when locals has none', async () => {
    // With auth off there is no locals.org; resolveOrgId returns the seeded default org.
    const id = await requireOrgId(fakeEvent(undefined));
    expect(typeof id).toBe('number');
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run web/tests/require-org.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm run typecheck && pnpm -F web check`
Expected: PASS.

```bash
git add web/src/hooks.server.ts web/src/lib/server/auth.ts web/tests/require-org.test.ts
git commit -m "feat(web): resolve active org in the hook, add requireOrgId guard helper"
```

---

## Task 5: `POST /api/orgs/switch`

**Files:**
- Create: `web/src/routes/api/orgs/switch/+server.ts`
- Test: `web/tests/orgs-switch.test.ts`

**Interfaces:**
- Consumes: `loadActiveOrganization` (Task 2), `setSessionActiveOrg` (Task 3).
- Produces: `POST /api/orgs/switch` body `{ organizationId }` -> `{ org }`; 403 for non-members.

- [ ] **Step 1: Write the failing test**

Create `web/tests/orgs-switch.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { createSession } from '@pitchbox/shared/auth';
import { POST } from '../src/routes/api/orgs/switch/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

function event(sessionId: string, userId: number, body: unknown): RequestEvent {
  return {
    locals: { user: { id: userId, username: 'x' } },
    request: new Request('http://x/api/orgs/switch', { method: 'POST', body: JSON.stringify(body) }),
    cookies: { get: (n: string) => (n === 'pitchbox_session' ? sessionId : undefined) },
  } as unknown as RequestEvent;
}

async function seed(username: string, slug: string, role = 'member') {
  const db = getDb();
  const [u] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
  const [o] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  await db.insert(schema.memberships).values({ organizationId: o.id, userId: u.id, role });
  const s = await createSession(db, u.id);
  return { userId: u.id, orgId: o.id, sessionId: s.id };
}

describe('POST /api/orgs/switch', () => {
  beforeEach(reset);

  it('switches to an org the user belongs to', async () => {
    const a = await seed('sw1', 'sw-a');
    const db = getDb();
    const [b] = await db.insert(schema.organizations).values({ slug: 'sw-b', name: 'B' }).returning();
    await db.insert(schema.memberships).values({ organizationId: b.id, userId: a.userId, role: 'member' });

    const res = await POST(event(a.sessionId, a.userId, { organizationId: b.id }));
    expect(res.status).toBe(200);
    const stored = await db.select().from(schema.sessions).where(sql`id = ${a.sessionId}`);
    expect(stored[0].activeOrganizationId).toBe(b.id);
  });

  it('rejects switching to an org the user is not a member of', async () => {
    const a = await seed('sw2', 'sw-c');
    const db = getDb();
    const [foreign] = await db.insert(schema.organizations).values({ slug: 'sw-x', name: 'X' }).returning();
    await expect(POST(event(a.sessionId, a.userId, { organizationId: foreign.id }))).rejects.toMatchObject({
      status: 403,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/orgs-switch.test.ts`
Expected: FAIL (module `.../switch/+server.js` not found).

- [ ] **Step 3: Implement the route**

Create `web/src/routes/api/orgs/switch/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { setSessionActiveOrg } from '@pitchbox/shared/auth';
import { loadActiveOrganization } from '@pitchbox/shared/orgs';

const SESSION_COOKIE = 'pitchbox_session';

export async function POST(event: import('@sveltejs/kit').RequestEvent) {
  const user = event.locals.user;
  if (!user) throw error(401, 'unauthenticated');
  const body = (await event.request.json()) as { organizationId?: number };
  if (!body.organizationId) throw error(400, 'organizationId required');

  const db = getDb();
  const org = await loadActiveOrganization(db, user.id, body.organizationId);
  if (!org || org.id !== body.organizationId) throw error(403, 'forbidden');

  const cookie = event.cookies.get(SESSION_COOKIE);
  if (cookie) await setSessionActiveOrg(db, cookie, org.id);
  return json({ org });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run web/tests/orgs-switch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/api/orgs/switch web/tests/orgs-switch.test.ts
git commit -m "feat(web): POST /api/orgs/switch to change the active organization"
```

---

## Task 6: `POST /api/orgs` (create organization)

**Files:**
- Create: `web/src/routes/api/orgs/+server.ts`
- Test: `web/tests/orgs-create.test.ts`

**Interfaces:**
- Consumes: `createOrganization` (Task 2), `setSessionActiveOrg` (Task 3).
- Produces: `POST /api/orgs` body `{ slug, name }` -> 201 `{ org }`; 409 on duplicate slug; switches active org to the new one.

- [ ] **Step 1: Write the failing test**

Create `web/tests/orgs-create.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { createSession } from '@pitchbox/shared/auth';
import { POST } from '../src/routes/api/orgs/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedUser(username: string) {
  const db = getDb();
  const [u] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
  const s = await createSession(db, u.id);
  return { userId: u.id, sessionId: s.id };
}
function event(sessionId: string, userId: number, body: unknown): RequestEvent {
  return {
    locals: { user: { id: userId, username: 'x' } },
    request: new Request('http://x/api/orgs', { method: 'POST', body: JSON.stringify(body) }),
    cookies: { get: (n: string) => (n === 'pitchbox_session' ? sessionId : undefined) },
  } as unknown as RequestEvent;
}

describe('POST /api/orgs', () => {
  beforeEach(reset);

  it('creates an org, owner membership, and switches active org', async () => {
    const u = await seedUser('cr1');
    const res = await POST(event(u.sessionId, u.userId, { slug: 'cr-new', name: 'New Co' }));
    expect(res.status).toBe(201);
    const db = getDb();
    const [stored] = await db.select().from(schema.sessions).where(sql`id = ${u.sessionId}`);
    const [org] = await db.select().from(schema.organizations).where(sql`slug = 'cr-new'`);
    expect(stored.activeOrganizationId).toBe(org.id);
  });

  it('rejects a duplicate slug', async () => {
    const u = await seedUser('cr2');
    await POST(event(u.sessionId, u.userId, { slug: 'cr-dup', name: 'One' }));
    await expect(POST(event(u.sessionId, u.userId, { slug: 'cr-dup', name: 'Two' }))).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it('rejects an invalid slug', async () => {
    const u = await seedUser('cr3');
    await expect(POST(event(u.sessionId, u.userId, { slug: 'Bad Slug!', name: 'X' }))).rejects.toMatchObject(
      { status: 400 },
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/orgs-create.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the route**

Create `web/src/routes/api/orgs/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { createOrganization } from '@pitchbox/shared/orgs';
import { setSessionActiveOrg } from '@pitchbox/shared/auth';

const SESSION_COOKIE = 'pitchbox_session';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export async function POST(event: import('@sveltejs/kit').RequestEvent) {
  const user = event.locals.user;
  if (!user) throw error(401, 'unauthenticated');
  const body = (await event.request.json()) as { slug?: string; name?: string };
  const slug = (body.slug ?? '').trim().toLowerCase();
  const name = (body.name ?? '').trim();
  if (!SLUG_RE.test(slug)) throw error(400, 'invalid slug');
  if (!name) throw error(400, 'name required');

  const db = getDb();
  try {
    const org = await createOrganization(db, { slug, name, ownerUserId: user.id });
    const cookie = event.cookies.get(SESSION_COOKIE);
    if (cookie) await setSessionActiveOrg(db, cookie, org.id);
    return json({ org }, { status: 201 });
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') throw error(409, 'slug taken');
    throw err;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run web/tests/orgs-create.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/api/orgs/+server.ts web/tests/orgs-create.test.ts
git commit -m "feat(web): POST /api/orgs to create an organization"
```

---

## Task 7: Guard the drafts routes

**Files:**
- Modify (add guard to each): `web/src/routes/api/drafts/[id]/+server.ts`, `.../[id]/regenerate/+server.ts`, `.../[id]/regenerate/cancel/+server.ts`, `.../[id]/regenerate/undo/+server.ts`, `.../[id]/reply-draft/cancel/+server.ts`, `.../[id]/reply-draft/retry/+server.ts`, `web/src/routes/api/drafts/bulk-approve/+server.ts`, `web/src/routes/api/drafts/bulk-reschedule/+server.ts`
- Test: `web/tests/route-guards-drafts.test.ts`

**Interfaces:**
- Consumes: `requireOrgId` (Task 4), `draftBelongsToOrg` (`@pitchbox/shared/orgs`).

**The guard pattern (single-id routes).** In each handler, after the id is parsed and before any DB read/mutation, insert:

```ts
const orgId = await requireOrgId(event);
if (!(await draftBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
```

For each file: (a) ensure the handler receives the full `event` (change e.g. `export async function PATCH({ params, request })` to `export async function PATCH(event)` and add `const { params, request } = event;` at the top); (b) add imports `import { requireOrgId } from '$lib/server/auth.js';`, `import { draftBelongsToOrg } from '@pitchbox/shared/orgs';`, and ensure `error` is imported from `@sveltejs/kit`; (c) `id` is `Number(params.id)` in every one of these files.

**The bulk routes** (`bulk-approve`, `bulk-reschedule`) operate on `ids: number[]`. Do not loop guards; instead constrain the fetch to the active org so foreign drafts are never selected. Replace the fetch:

```ts
const drafts = await db.select().from(schema.drafts).where(inArray(schema.drafts.id, ids));
```

with an org-scoped fetch:

```ts
const orgId = await requireOrgId(event);
const drafts = await db
  .select()
  .from(schema.drafts)
  .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
  .where(and(inArray(schema.drafts.id, ids), eq(schema.projects.organizationId, orgId)));
```

Because of the join, each element becomes `{ drafts: {...}, projects: {...} }`. Update the downstream `for (const draft of drafts)` to read `row.drafts` (rename the loop variable accordingly, e.g. `for (const { drafts: draft } of drafts)`). Ensure `and`, `eq`, `inArray` are imported from `drizzle-orm`.

- [ ] **Step 1: Write the failing test**

Create `web/tests/route-guards-drafts.test.ts` (reuse the `seedOrgWithProject` factory from `org-isolation.test.ts`; copy it in, since there are no shared factories):

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { PATCH } from '../src/routes/api/drafts/[id]/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Copy of seedOrgWithProject from org-isolation.test.ts (no shared factory exists).
async function seedOrgWithProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `${slug}-proj`, name: `${slug} p`, defaultAgentRunner: 'claude-code' })
    .returning();
  const [platform] = await db.select().from(schema.platforms).where(sql`slug = 'reddit'`);
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: project.id, platformId: platform.id, handle: `${slug}-a`, role: 'personal' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ projectId: project.id, agentRunner: 'claude-code', kind: 'campaign', trigger: 'manual', status: 'succeeded' })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({ runId: run.id, projectId: project.id, platformId: platform.id, accountId: account.id, kind: 'dm', state: 'pending_review', targetUser: 'u', body: 'hi', version: 1 })
    .returning();
  return { orgId: org.id, draftId: draft.id, version: draft.version };
}

function patchEvent(orgId: number, draftId: number, body: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' }, user: { id: 1, username: 'x' } },
    params: { id: String(draftId) },
    request: new Request('http://x/', { method: 'PATCH', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

describe('drafts PATCH tenant guard', () => {
  beforeEach(reset);

  it('rejects a draft owned by another org with 404', async () => {
    const a = await seedOrgWithProject('rg-a');
    const b = await seedOrgWithProject('rg-b');
    // Caller is org B, target draft belongs to org A.
    await expect(PATCH(patchEvent(b.orgId, a.draftId, { expectedVersion: a.version, body: 'x' }))).rejects.toMatchObject(
      { status: 404 },
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/route-guards-drafts.test.ts`
Expected: FAIL (no guard yet, so the PATCH proceeds and does not throw 404).

- [ ] **Step 3: Apply the guard to `api/drafts/[id]/+server.ts`**

Add imports, accept `event`, and insert after `const id = Number(params.id);`:

```ts
const orgId = await requireOrgId(event);
if (!(await draftBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
```

- [ ] **Step 4: Run the representative test to verify it passes**

Run: `pnpm exec vitest run web/tests/route-guards-drafts.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply the same guard to the remaining single-id drafts routes**

Apply the identical single-id guard pattern (with `draftBelongsToOrg` and `id = Number(params.id)`) to each of: `[id]/regenerate/+server.ts`, `[id]/regenerate/cancel/+server.ts`, `[id]/regenerate/undo/+server.ts`, `[id]/reply-draft/cancel/+server.ts`, `[id]/reply-draft/retry/+server.ts`. Apply the bulk-fetch org-scoping to `bulk-approve/+server.ts` and `bulk-reschedule/+server.ts`.

- [ ] **Step 6: Verify the whole file typechecks and svelte-checks**

Run: `pnpm run typecheck && pnpm -F web check && pnpm exec vitest run web/tests/route-guards-drafts.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/api/drafts web/tests/route-guards-drafts.test.ts
git commit -m "feat(web): enforce org isolation on all drafts routes"
```

---

## Task 8: Guard the campaigns routes and add the run-dispatch tenant check

**Files:**
- Modify: `web/src/routes/api/campaigns/[id]/+server.ts`, `.../[id]/skill-runs/+server.ts`, `.../[id]/skill-runs/[runId]/adopt/+server.ts`, `.../[id]/skill-runs/[runId]/discard/+server.ts`, `.../[id]/keyword-watches/+server.ts`, `web/src/routes/api/campaigns/+server.ts`, `web/src/routes/api/run/+server.ts`
- Test: `web/tests/route-guards-campaigns.test.ts`

**Interfaces:**
- Consumes: `requireOrgId`, `campaignBelongsToOrg`, `projectBelongsToOrg`.

**Campaign by-id routes** (`[id]/**`): the guard is `campaignBelongsToOrg(getDb(), id, orgId)` with `id = Number(params.id)`, inserted at the top of every exported handler (GET, POST, PATCH, DELETE) in these files:

```ts
const orgId = await requireOrgId(event);
if (!(await campaignBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
```

**Campaign create** (`api/campaigns/+server.ts` POST): the tenant boundary is the parent project. After parsing `body.projectId`, insert:

```ts
const orgId = await requireOrgId(event);
if (!(await projectBelongsToOrg(getDb(), body.projectId, orgId))) throw error(404, 'not_found');
```

**Run dispatch** (`api/run/+server.ts` POST): only session callers are checked; the daemon/self-host path (no `locals.org`) is left alone so scheduling keeps working. Change the handler to accept the full event and use `locals`:

```ts
export async function POST(event) {
  const { request, locals } = event;
  const body = (await request.json()) as { campaignId?: number; trigger?: string; scheduledFor?: string };
  if (!body.campaignId) throw error(400, 'campaignId required');
  const trigger = body.trigger && ALLOWED_TRIGGERS.has(body.trigger) ? body.trigger : 'manual';

  if (locals.org) {
    const { getDb } = await import('$lib/server/db.js');
    const { campaignBelongsToOrg } = await import('@pitchbox/shared/orgs');
    if (!(await campaignBelongsToOrg(getDb(), body.campaignId, locals.org.id))) {
      throw error(404, 'not_found');
    }
  }
  // ...unchanged readiness check + runCampaign dispatch...
}
```

(Prefer top-of-file static imports over the dynamic `await import(...)` shown above if the file has no import cycle concerns; the dynamic form is only to keep the diff minimal.)

- [ ] **Step 1: Write the failing test**

Create `web/tests/route-guards-campaigns.test.ts` mirroring Task 7's structure. Import `PATCH` from `api/campaigns/[id]/+server.js` and `POST` from `api/run/+server.js`. Seed two orgs with a campaign each (extend the `seedOrgWithProject` copy to also return `campaignId`, as in `org-isolation.test.ts`). Assert:
  - `PATCH` on org A's campaign as org B rejects with 404.
  - `POST /api/run` with `locals.org = B` and org A's `campaignId` rejects with 404.
  - `POST /api/run` with no `locals.org` (daemon/self-host) does NOT throw 404 for the org reason (it may fail later for readiness; assert it is not a 404 tenant rejection, e.g. by giving a ready campaign and expecting a `runId`, or by asserting the thrown error is not status 404).

```ts
// Representative assertion for the run-dispatch guard:
await expect(
  runPost({ locals: { org: { id: b.orgId, slug: 'b', role: 'owner' } }, request: new Request('http://x/', { method: 'POST', body: JSON.stringify({ campaignId: a.campaignId }) }) } as unknown as RequestEvent),
).rejects.toMatchObject({ status: 404 });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/route-guards-campaigns.test.ts`
Expected: FAIL.

- [ ] **Step 3: Apply the campaign guards and the run-dispatch check** as specified above.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run web/tests/route-guards-campaigns.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `pnpm run typecheck && pnpm -F web check`
Expected: PASS.

```bash
git add web/src/routes/api/campaigns web/src/routes/api/run web/tests/route-guards-campaigns.test.ts
git commit -m "feat(web): enforce org isolation on campaign routes and run dispatch"
```

---

## Task 9: Guard the projects subtree, runs, blocklist, and recommendations routes

**Files:**
- Modify (guard = `projectBelongsToOrg(getDb(), Number(params.id), orgId)` in every exported handler): `web/src/routes/api/projects/[id]/+server.ts`, `.../[id]/extraction-uploads/+server.ts`, `.../[id]/runs/+server.ts`, `.../[id]/accounts/+server.ts`, `.../[id]/accounts/[accountId]/+server.ts`, `.../[id]/templates/+server.ts`, `.../[id]/templates/[templateId]/+server.ts`, `.../[id]/insights/+server.ts`, `.../[id]/recommendations/+server.ts`, `.../[id]/recommendations/[recId]/+server.ts`
- Modify (guard = `runBelongsToOrg`): `web/src/routes/api/runs/[id]/events/+server.ts`, `web/src/routes/api/run/[id]/+server.ts`
- Modify (blocklist, special-cased): `web/src/routes/api/blocklist/[id]/+server.ts`, `web/src/routes/api/blocklist/+server.ts`
- Test: `web/tests/route-guards-projects.test.ts`

**Interfaces:**
- Consumes: `requireOrgId`, `projectBelongsToOrg`, `runBelongsToOrg`.

**Projects subtree.** For every `projects/[id]/**` file, the parent project id is `Number(params.id)`, and any nested `[accountId]`/`[templateId]`/`[recId]` is already constrained by `projectId` in the existing query. So a single guard per handler suffices:

```ts
const orgId = await requireOrgId(event);
if (!(await projectBelongsToOrg(getDb(), Number(params.id), orgId))) throw error(404, 'not_found');
```

**Runs.** `runs/[id]/events` and `run/[id]` (cancel): guard with `runBelongsToOrg(getDb(), Number(params.id), orgId)`.

**Blocklist DELETE** (`blocklist/[id]/+server.ts`): fetch the row first, then guard only project-scoped rows (global rows are a shared resource, per the plan's known limitations):

```ts
const orgId = await requireOrgId(event);
const [row] = await getDb().select().from(schema.blocklist).where(eq(schema.blocklist.id, id));
if (!row) throw error(404, 'not_found');
if (row.projectId && !(await projectBelongsToOrg(getDb(), row.projectId, orgId))) throw error(404, 'not_found');
```

**Blocklist POST** (`blocklist/+server.ts`): when `scope === 'project'` and `body.projectId` is set, guard the project:

```ts
const orgId = await requireOrgId(event);
if (scope === 'project' && body.projectId && !(await projectBelongsToOrg(getDb(), body.projectId, orgId))) {
  throw error(404, 'not_found');
}
```

- [ ] **Step 1: Write the failing test**

Create `web/tests/route-guards-projects.test.ts`. Import `GET` (or `PATCH`/`DELETE`) from `api/projects/[id]/+server.js`. Seed two orgs each with a project (reuse the `seedOrgWithProject` copy). Assert that calling the handler with `locals.org = orgB` and `params.id = projectA.id` rejects with 404, and with `locals.org = orgA` returns a project (not a 404). Add one case for `runs/[id]/events` GET (org B against org A's run -> 404).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/route-guards-projects.test.ts`
Expected: FAIL.

- [ ] **Step 3: Apply the guards** to every file listed above.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run web/tests/route-guards-projects.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `pnpm run typecheck && pnpm -F web check`
Expected: PASS.

```bash
git add web/src/routes/api/projects web/src/routes/api/runs web/src/routes/api/run/[id] web/src/routes/api/blocklist web/tests/route-guards-projects.test.ts
git commit -m "feat(web): enforce org isolation on project subtree, runs, and blocklist routes"
```

---

## Task 10: Fix the list-page and export leaks

**Files:**
- Modify: `web/src/routes/campaigns/+page.server.ts` (leak at line 37; also `latestRuns` :39-50 and `draftCounts` :63-73)
- Modify: `web/src/routes/inbox/+page.server.ts` (filters at 58-62; main query at 134-140)
- Modify: `web/src/routes/api/analytics/funnel/+server.ts`
- Modify: `web/src/routes/api/export/[resource]/+server.ts`
- Test: `web/tests/list-leaks.test.ts`

**Interfaces:**
- Consumes: `resolveOrgId` (existing), the active org's project ids.

**Approach.** Every one of these reads must be constrained to the active org's projects. The projects list is already org-scoped via `listProjects(db, { organizationId: orgId })`; derive `const projectIds = projects.map((p) => p.id);` and constrain the tenant queries with `inArray(schema.<table>.projectId, projectIds)` (guarding for the empty case: if `projectIds.length === 0`, return empty results without querying, since `inArray(x, [])` is a SQL error).

**campaigns page.** Replace the campaign `where` (line 37) so it is always org-scoped, independent of `activeProject`:

```ts
const projectIds = projects.map((p) => p.id);
if (projectIds.length === 0) {
  return { projects, campaigns: [], /* ...other empty defaults... */ };
}
const campaignScope = activeProject
  ? eq(schema.campaigns.projectId, activeProject.id)
  : inArray(schema.campaigns.projectId, projectIds);
// ...
.where(campaignScope);
```

Also constrain `latestRuns` and `draftCounts` by `inArray(schema.runs.projectId, projectIds)` / `inArray(schema.drafts.projectId, projectIds)` respectively (they currently filter only on `isNotNull(campaignId)`).

**inbox page.** Seed the filter list with a mandatory org scope so it applies even when no project is selected:

```ts
const projectIds = projects.map((p) => p.id);
if (projectIds.length === 0) {
  // render an empty inbox for an org with no projects
}
const filters: SQL[] = [inArray(schema.drafts.projectId, projectIds)];
if (state !== 'all') filters.push(eq(schema.drafts.state, state));
// ...existing pushes (kind, activeProject, platform, minQuality) unchanged...
```

**analytics/funnel** and **export/[resource]**: resolve `orgId` via `resolveOrgId(event)`, derive the org's project ids, and add `inArray(<table>.projectId, projectIds)` to each aggregate/select (in `export`, thread the org scope into `streamCsv`; if `streamCsv` cannot currently take a scope, pass `projectIds` as a parameter and filter inside it).

- [ ] **Step 1: Write the failing test**

Create `web/tests/list-leaks.test.ts`. Import `load` from `../src/routes/campaigns/+page.server.js`. Seed two orgs, each with a campaign (reuse `seedOrgWithProject`). Build a fake event with `locals.org = orgA` and `url` without a `?project=` param. Assert the returned `campaigns` contains only org A's campaign, not org B's:

```ts
const data = await load(fakeEvent(orgA, 'http://x/campaigns'));
const ids = data.campaigns.map((c: { id: number }) => c.id);
expect(ids).toContain(a.campaignId);
expect(ids).not.toContain(b.campaignId);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/list-leaks.test.ts`
Expected: FAIL (org B's campaign leaks into the unscoped list).

- [ ] **Step 3: Apply the scoping** to the four files as specified.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run web/tests/list-leaks.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `pnpm run typecheck && pnpm -F web check`
Expected: PASS.

```bash
git add web/src/routes/campaigns/+page.server.ts web/src/routes/inbox/+page.server.ts web/src/routes/api/analytics web/src/routes/api/export web/tests/list-leaks.test.ts
git commit -m "fix(web): scope campaign/inbox/analytics/export reads to the active org"
```

---

## Task 11: Organization switcher UI

**Files:**
- Modify: `web/src/routes/+layout.server.ts` (expose active org + membership list when auth is on)
- Modify: `web/src/lib/components/Sidebar.svelte` (render the switcher + create-org control)
- Test: `web/tests/layout-orgs.test.ts`

**Interfaces:**
- Consumes: `listUserOrganizations` (Task 2), `POST /api/orgs/switch` (Task 5), `POST /api/orgs` (Task 6).

- [ ] **Step 1: Write the failing test (layout loader)**

Create `web/tests/layout-orgs.test.ts`. Import `load` from `../src/routes/+layout.server.js`. With `locals.user` + `locals.org` set and two memberships seeded, assert `load` returns `{ authOn, org, orgs }` where `orgs` lists both memberships. With no `locals.user`, assert `orgs` is empty and `org` is undefined.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run web/tests/layout-orgs.test.ts`
Expected: FAIL (loader currently returns only `authOn`).

- [ ] **Step 3: Extend the layout loader**

Replace `web/src/routes/+layout.server.ts`:

```ts
import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { listUserOrganizations } from '@pitchbox/shared/orgs';

/**
 * Root layout loader. Exposes server-wide flags every page needs: `authOn`,
 * the active organization, and the caller's organizations (for the switcher).
 */
export const load: LayoutServerLoad = async (event) => {
  const authOn = process.env.PITCHBOX_AUTH === 'on';
  const user = event.locals.user;
  const orgs = user ? await listUserOrganizations(getDb(), user.id) : [];
  return {
    authOn,
    org: event.locals.org,
    orgs,
  };
};
```

- [ ] **Step 4: Run the loader test to verify it passes**

Run: `pnpm exec vitest run web/tests/layout-orgs.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the switcher to the Sidebar**

In `web/src/lib/components/Sidebar.svelte`, read `data.authOn`, `data.org`, `data.orgs` from `$app/stores` `page.data`. When `authOn` and `data.orgs.length > 0`, render a switcher near the top. Minimal, dependency-free implementation:

```svelte
<script lang="ts">
  import { page } from '$app/stores';
  import { invalidateAll } from '$app/navigation';

  async function switchOrg(e: Event) {
    const organizationId = Number((e.currentTarget as HTMLSelectElement).value);
    await fetch('/api/orgs/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    });
    await invalidateAll();
  }

  async function createOrg() {
    const name = prompt('Organization name');
    if (!name) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const res = await fetch('/api/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, name }),
    });
    if (res.ok) await invalidateAll();
    else alert('Could not create organization');
  }
</script>

{#if $page.data.authOn && $page.data.orgs?.length}
  <div class="px-3 py-2">
    <select
      class="w-full rounded border bg-background p-2 text-sm"
      value={$page.data.org?.id}
      onchange={switchOrg}
    >
      {#each $page.data.orgs as o (o.id)}
        <option value={o.id}>{o.name}</option>
      {/each}
    </select>
    <button class="mt-1 text-xs text-muted-foreground hover:underline" onclick={createOrg}>
      + New organization
    </button>
  </div>
{/if}
```

Match the surrounding Svelte 5 idiom in the file (runes, `onclick`/`onchange` attribute form). If `Sidebar.svelte` receives props rather than reading `$page`, adapt to the existing pattern.

- [ ] **Step 6: Verify the UI compiles**

Run: `pnpm -F web check && pnpm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/+layout.server.ts web/src/lib/components/Sidebar.svelte web/tests/layout-orgs.test.ts
git commit -m "feat(web): organization switcher and create-org control in the sidebar"
```

---

## Task 12: Full-suite verification and design cross-check

**Files:** none (verification only)

- [ ] **Step 1: Run the whole quality gate**

Run: `pnpm run lint && pnpm run typecheck && pnpm -F web check && pnpm test`
Expected: all PASS. Read the output; do not infer.

- [ ] **Step 2: Manual auth-off smoke check**

With `PITCHBOX_AUTH` unset (default off), run `pnpm run dev` and confirm: no switcher renders, the app resolves to the `default` org, and projects/campaigns/inbox load as before. This confirms the self-host path is unchanged.

- [ ] **Step 3: Cross-check against the design**

Re-read `docs/organization-isolation-design.md` and confirm every section maps to a shipped task: schema (Task 1), active-org + switcher (Tasks 2-6, 11), enforcement + guards (Tasks 7-9), list-leak fixes (Task 10), residual risks unchanged (contact_history global, extension routes, global blocklist, MCP trust). Note any gap.

- [ ] **Step 4: Commit any final fixups**

```bash
git add -A
git commit -m "chore: organization isolation follow-ups from full-suite verification"
```

---

## Self-review notes (author)

- Spec coverage: schema (T1), multi-org membership + active org (T2/T3/T4), switcher (T5), create-org (T6), enforcement across by-id routes (T7/T8/T9), run-dispatch check (T8), list-leak fixes (T10), UI (T11), verification (T12). `contact_history`, `/api/extension/*`, global blocklist, and the MCP layer are intentionally out of scope and documented as known limitations.
- The `/api/run` daemon path is preserved by gating the tenant check on `locals.org` being present (only session callers are checked).
- Type consistency: guard signature is `(db, id, orgId) => Promise<boolean>` everywhere; `loadActiveOrganization` returns `{ id, slug, role }`; `listUserOrganizations` returns `{ id, slug, name, role }`; `requireOrgId` returns `number` (throws on null).
