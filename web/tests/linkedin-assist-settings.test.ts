import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import {
  ASSIST_COMMENT_CAP_CEILING,
  ASSIST_POST_CAP_CEILING,
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
  loadLinkedInAssistDeviceState,
} from '@pitchbox/shared/linkedin-assist';
import { GET, POST } from '../src/routes/api/settings/linkedin-assist/+server.js';
import { GET as deviceGet } from '../src/routes/api/extension/linkedin-assist/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

// LI-19 (#316): the off switch and owner for the in-page LinkedIn assistant.
// Two boundaries to defend, per docs/linkedin-integration-design.md: the API
// (not the settings page) is the enforcement boundary for who may write it,
// and there is no cache between a save and the extension's next read, so a
// kill switch actually stops something "immediately" rather than at the next
// alarm.

const PASSWORD = 'correct-horse-battery';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
  await db.execute(
    sql`TRUNCATE extension_devices, projects, memberships, users RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedOrg(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

function ev(orgId: number, role: string, method: 'GET' | 'POST', body?: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
    request: new Request('http://x/', {
      method,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  } as unknown as RequestEvent;
}

async function statusOf(fn: () => Promise<Response>): Promise<number> {
  try {
    return (await fn()).status;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function mintDevice(organizationId: number | null, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' });
}

function deviceRequest(token: string | null): Request {
  return new Request('http://x/api/extension/linkedin-assist', {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('GET /api/settings/linkedin-assist', () => {
  beforeEach(reset);

  it('a member is forbidden (403)', async () => {
    const { orgId } = await seedOrg('la-member');
    expect(await statusOf(() => GET(ev(orgId, 'member', 'GET')))).toBe(403);
  });

  it('an admin reads the defaults (off, unbound, capped at the ceiling)', async () => {
    const { orgId } = await seedOrg('la-admin-get');
    const res = await GET(ev(orgId, 'admin', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      enabled: false,
      projectId: null,
      collectorEnabled: false,
      dailyCommentCap: ASSIST_COMMENT_CAP_CEILING,
      dailyPostCap: ASSIST_POST_CAP_CEILING,
      killSwitch: false,
    });
  });
});

describe('POST /api/settings/linkedin-assist', () => {
  beforeEach(reset);

  it('a member cannot write the setting (403), and nothing is saved', async () => {
    const { orgId, projectId } = await seedOrg('la-member-write');
    const attempt = {
      enabled: true,
      projectId,
      collectorEnabled: true,
      dailyCommentCap: 1,
      dailyPostCap: 1,
      killSwitch: false,
    };
    expect(await statusOf(() => POST(ev(orgId, 'member', 'POST', attempt)))).toBe(403);
    const state = await loadLinkedInAssistDeviceState(getDb(), orgId);
    expect(state.enabled).toBe(false);
  });

  it('an admin can write the setting and it persists', async () => {
    const { orgId, projectId } = await seedOrg('la-admin-write');
    const body = {
      enabled: true,
      projectId,
      collectorEnabled: true,
      dailyCommentCap: 3,
      dailyPostCap: 1,
      killSwitch: false,
    };
    const res = await POST(ev(orgId, 'admin', 'POST', body));
    expect(res.status).toBe(200);
    const state = await loadLinkedInAssistDeviceState(getDb(), orgId);
    expect(state).toMatchObject({
      enabled: true,
      collectorEnabled: true,
      projectId,
      dailyCommentCap: 3,
      dailyPostCap: 1,
    });
  });

  it('refuses a comment cap above the code ceiling (400)', async () => {
    const { orgId, projectId } = await seedOrg('la-comment-ceiling');
    const body = {
      ...defaultLinkedInAssistSettings(),
      projectId,
      dailyCommentCap: ASSIST_COMMENT_CAP_CEILING + 1,
    };
    expect(await statusOf(() => POST(ev(orgId, 'admin', 'POST', body)))).toBe(400);
  });

  it('refuses a post cap above the code ceiling (400)', async () => {
    const { orgId, projectId } = await seedOrg('la-post-ceiling');
    const body = {
      ...defaultLinkedInAssistSettings(),
      projectId,
      dailyPostCap: ASSIST_POST_CAP_CEILING + 1,
    };
    expect(await statusOf(() => POST(ev(orgId, 'admin', 'POST', body)))).toBe(400);
  });

  it('allows lowering a cap below the ceiling', async () => {
    const { orgId, projectId } = await seedOrg('la-lower-cap');
    const body = {
      ...defaultLinkedInAssistSettings(),
      projectId,
      dailyCommentCap: 1,
      dailyPostCap: 0,
    };
    expect(await statusOf(() => POST(ev(orgId, 'admin', 'POST', body)))).toBe(200);
  });

  it('refuses enabling assist without a bound project (400)', async () => {
    const { orgId } = await seedOrg('la-unbound');
    const body = { ...defaultLinkedInAssistSettings(), enabled: true, projectId: null };
    expect(await statusOf(() => POST(ev(orgId, 'admin', 'POST', body)))).toBe(400);
  });

  it("refuses binding another organization's project (400)", async () => {
    const { orgId } = await seedOrg('la-cross-org-a');
    const { projectId: otherProjectId } = await seedOrg('la-cross-org-b');
    const body = { ...defaultLinkedInAssistSettings(), enabled: true, projectId: otherProjectId };
    expect(await statusOf(() => POST(ev(orgId, 'admin', 'POST', body)))).toBe(400);
  });
});

describe('GET /api/extension/linkedin-assist (device read path)', () => {
  beforeEach(reset);

  it('rejects a request with no bearer token (401)', async () => {
    expect(await statusOf(() => deviceGet({ request: deviceRequest(null) }))).toBe(401);
  });

  it('rejects an unknown token (401)', async () => {
    expect(await statusOf(() => deviceGet({ request: deviceRequest('not-a-real-token') }))).toBe(
      401,
    );
  });

  it('a device sees only its own organization, never a sibling org', async () => {
    const { orgId: orgA, projectId: projectA } = await seedOrg('la-device-a');
    const { orgId: orgB, projectId: projectB } = await seedOrg('la-device-b');
    await saveLinkedInAssistSettings(getDb(), orgA, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: projectA,
    });
    await saveLinkedInAssistSettings(getDb(), orgB, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: projectB,
    });

    const token = 'device-token-a';
    await mintDevice(orgA, token);
    const res = await deviceGet({ request: deviceRequest(token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assist.projectId).toBe(projectA);
    expect(body.assist.projectId).not.toBe(projectB);
  });

  it('the kill switch is visible on the very next read, with no caching', async () => {
    const { orgId, projectId } = await seedOrg('la-kill-switch');
    await saveLinkedInAssistSettings(getDb(), orgId, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId,
      collectorEnabled: true,
    });
    const token = 'device-token-kill';
    await mintDevice(orgId, token);

    const before = await (await deviceGet({ request: deviceRequest(token) })).json();
    expect(before.assist.enabled).toBe(true);
    expect(before.assist.collectorEnabled).toBe(true);

    // Flip the kill switch the same way the settings page does - through the
    // save path, not a direct DB write - then read again with no delay and
    // no cache invalidation step of any kind.
    await POST(
      ev(orgId, 'admin', 'POST', {
        enabled: true,
        projectId,
        collectorEnabled: true,
        dailyCommentCap: ASSIST_COMMENT_CAP_CEILING,
        dailyPostCap: ASSIST_POST_CAP_CEILING,
        killSwitch: true,
      }),
    );

    const after = await (await deviceGet({ request: deviceRequest(token) })).json();
    expect(after.assist.killSwitch).toBe(true);
    expect(after.assist.enabled).toBe(false);
    expect(after.assist.collectorEnabled).toBe(false);
  });

  it('treats a deleted bound project as unbound rather than leaking a dangling id', async () => {
    const { orgId, projectId } = await seedOrg('la-deleted-project');
    await saveLinkedInAssistSettings(getDb(), orgId, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId,
    });
    await getDb().delete(schema.projects).where(eq(schema.projects.id, projectId));

    const token = 'device-token-deleted-project';
    await mintDevice(orgId, token);
    const body = await (await deviceGet({ request: deviceRequest(token) })).json();
    expect(body.assist.projectId).toBeNull();
    expect(body.assist.enabled).toBe(false);
  });
});

// The role gate is exactly the kind of bug ISO-1 (#132) hid: a hand-injected
// locals.org (as above) can't catch a hooks.server.ts wiring mistake, because
// the hook never runs. Drive these through the real handle() hook instead
// (see helpers/handle-harness.ts).
describe('role gate (real handle() path)', () => {
  async function sessionFor(username: string, role: 'member' | 'admin'): Promise<CookieJar> {
    const hash = await hashPassword(PASSWORD);
    await getDb()
      .insert(schema.users)
      .values({ username, passwordHash: hash })
      .onConflictDoNothing();
    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(sql`username = ${username}`);
    let [org] = await getDb()
      .select()
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    if (!org) {
      [org] = await getDb()
        .insert(schema.organizations)
        .values({ slug: 'default', name: 'Default' })
        .returning();
    }
    await getDb()
      .insert(schema.memberships)
      .values({ organizationId: org.id, userId: user.id, role })
      .onConflictDoUpdate({
        target: [schema.memberships.organizationId, schema.memberships.userId],
        set: { role },
      });
    const session = await createSession(getDb(), user.id);
    return { store: new Map([['pitchbox_session', { value: session.id }]]) };
  }

  it('a member session is forbidden (403)', async () => {
    const jar = await sessionFor('la-rg-member', 'member');
    const req = new Request('http://localhost/api/settings/linkedin-assist');
    await expect(runThroughHandle(req, jar, GET as any)).rejects.toMatchObject({ status: 403 });
  });

  it('an admin session can read the settings (200)', async () => {
    const jar = await sessionFor('la-rg-admin', 'admin');
    const req = new Request('http://localhost/api/settings/linkedin-assist');
    const res = await runThroughHandle(req, jar, GET as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect('enabled' in body).toBe(true);
  });
});

afterAll(async () => {
  await getPool().end();
});
