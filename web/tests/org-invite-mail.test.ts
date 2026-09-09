import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import type { MailMessage, MailTransport } from '@pitchbox/shared/mail';

/**
 * #510: creating an invite with an address sends it through
 * `@pitchbox/shared/mail` rather than requiring the address be copied by
 * hand. `createMailTransport` is faked here (mirrors `createAgentRunner`
 * being faked in extension-suggest-voice.test.ts) so a test can assert on
 * exactly what would have been sent, without depending on the null
 * transport's console logging.
 */

const { sent, transportState } = vi.hoisted(() => {
  const sent: MailMessage[] = [];
  const transportState = { name: 'smtp' };
  return { sent, transportState };
});

vi.mock('@pitchbox/shared/mail/registry', () => ({
  createMailTransport: (): MailTransport => ({
    get name() {
      return transportState.name;
    },
    async send(message: MailMessage) {
      sent.push(message);
    },
  }),
}));

// Dynamic on purpose: `vi.mock` above is hoisted, but the route module has to
// load after it for `createMailTransport` to resolve to the fake - a static
// import here would race the hoisted mock (same pattern as
// extension-suggest-voice.test.ts).
const { POST } = await import('../src/routes/api/orgs/[slug]/invites/+server.js');

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM org_invites`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  sent.length = 0;
  transportState.name = 'smtp';
}

async function seed(username: string, slug: string, orgName: string, role: string) {
  const db = getDb();
  const [u] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
  const [o] = await db.insert(schema.organizations).values({ slug, name: orgName }).returning();
  await db.insert(schema.memberships).values({ organizationId: o.id, userId: u.id, role });
  return { userId: u.id, orgId: o.id, slug };
}

function ev(
  userId: number,
  slug: string,
  body: unknown,
  origin = 'https://app.pitchbox.app',
): RequestEvent {
  return {
    locals: { user: { id: userId, username: 'x' } },
    params: { slug },
    request: new Request(`${origin}/api/orgs/${slug}/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    url: new URL(`${origin}/api/orgs/${slug}/invites`),
  } as unknown as RequestEvent;
}

describe('POST /api/orgs/[slug]/invites - email delivery (#510)', () => {
  beforeEach(reset);

  it('sends exactly one message, to the invited address, carrying the link/org/role', async () => {
    const a = await seed('owner1', 'inv-a', 'Acme Inc', 'owner');
    const res = await POST(ev(a.userId, 'inv-a', { email: 'friend@example.com', role: 'admin' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string; emailSent: boolean };

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('friend@example.com');
    expect(sent[0].text).toContain(body.url);
    expect(sent[0].text).toContain('Acme Inc');
    expect(sent[0].text).toContain('admin');
    expect(body.emailSent).toBe(true);
  });

  it('sends nothing and still returns the link when no address is given', async () => {
    const a = await seed('owner2', 'inv-b', 'Beta Co', 'owner');
    const res = await POST(ev(a.userId, 'inv-b', { role: 'member' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string; emailSent: boolean };

    expect(sent).toHaveLength(0);
    expect(body.url).toMatch(/^https:\/\/app\.pitchbox\.app\/invite\//);
    expect(body.emailSent).toBe(false);
  });

  it('builds the link in the message from the request origin, not a hardcoded host', async () => {
    const a = await seed('owner3', 'inv-c', 'Gamma LLC', 'owner');
    const res = await POST(
      ev(
        a.userId,
        'inv-c',
        { email: 'x@example.com', role: 'member' },
        'https://preview.pitchbox.app',
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string };

    expect(body.url.startsWith('https://preview.pitchbox.app/invite/')).toBe(true);
    expect(sent[0].text).toContain('https://preview.pitchbox.app/invite/');
    expect(sent[0].text).not.toContain('app.pitchbox.app');
  });

  it('reports emailSent false when the deployment has no real transport configured', async () => {
    transportState.name = 'null';
    const a = await seed('owner4', 'inv-d', 'Delta', 'owner');
    const res = await POST(ev(a.userId, 'inv-d', { email: 'x@example.com', role: 'member' }));
    const body = (await res.json()) as { emailSent: boolean };

    // The null transport still "sends" (logs and drops) - it is attempted,
    // it just doesn't reach anyone, which is what emailSent tells the UI.
    expect(sent).toHaveLength(1);
    expect(body.emailSent).toBe(false);
  });

  it('rejects a member (not admin/owner) with 404 and sends nothing', async () => {
    const m = await seed('member1', 'inv-e', 'Epsilon', 'member');
    const res = await POST(ev(m.userId, 'inv-e', { email: 'x@example.com', role: 'member' }));
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});
