import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { en as extensionEn } from '../../extension/src/lib/i18n/dict-en.js';
import { it as extensionIt } from '../../extension/src/lib/i18n/dict-it.js';
import { POST as suggest } from '../src/routes/api/extension/suggest/+server.js';

/**
 * LOR-264: the design decision recorded in docs/design/DECISIONS.md - the
 * assist plane's refusal answers a machine key alone (`{ refused, platform }`,
 * no `message` field), because the extension already carries its own
 * `assist.refusal.*` catalogue and renders it in whatever locale the panel is
 * actually running in (LOR-260/LOR-262's account preference, reaching the
 * panel through pairing - see extension/tests/content/panel-locale-render.test.ts
 * and linkedin-post-assist-locale.test.ts for that half). This test proves
 * the two halves fit together: the server's key never carries prose and
 * never changes shape, and that same key resolves to a real, actionable
 * Italian sentence in the extension's own dictionary - not just a fallback
 * to the bare key or to English.
 */

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, contact_history, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
}

async function seedOrgProject(slug: string, opts: { assist?: boolean } = {}) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug, description: `about ${slug}` })
    .returning();
  if (opts.assist ?? true) {
    await saveLinkedInAssistSettings(db, org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
    });
  }
  return { org, project };
}

async function mintDevice(organizationId: number, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' });
}

const POST_BODY = {
  kind: 'post_comment' as const,
  post: {
    urn: 'urn:li:activity:7000000000000000002',
    authorName: 'Giulia Bianchi',
    text: 'We cut p99 in half.',
  },
};

function request(token: string, headers: Record<string, string> = {}) {
  return new Request('http://x/api/extension/suggest', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(POST_BODY),
  });
}

describe('POST /api/extension/suggest refusal: key stays stable, the Italian sentence lives in the extension (LOR-264)', () => {
  beforeEach(reset);

  it('answers the same bare {refused, platform} shape regardless of the caller-declared language', async () => {
    const { org } = await seedOrgProject('refusal-locale-en', { assist: false });
    await mintDevice(org.id, 'tok-en');

    const enRes = await suggest({
      request: request('tok-en', { 'accept-language': 'en' }),
    } as never);
    const enBody = await enRes.json();

    const { org: orgIt } = await seedOrgProject('refusal-locale-it', { assist: false });
    await mintDevice(orgIt.id, 'tok-it');
    const itRes = await suggest({
      request: request('tok-it', { 'accept-language': 'it-IT,it;q=0.9' }),
    } as never);
    const itBody = await itRes.json();

    // The machine-readable key is identical either way - an
    // Accept-Language the server happens to see never touches it, and
    // there is no `message` field at all to disagree in prose.
    expect(enBody).toEqual({ refused: 'assist_disabled', platform: 'linkedin' });
    expect(itBody).toEqual({ refused: 'assist_disabled', platform: 'linkedin' });
  });

  it('names the kill switch distinctly from a plain disable, in both cases key-only', async () => {
    const { org, project } = await seedOrgProject('refusal-locale-kill', { assist: false });
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
      killSwitch: true,
    });
    await mintDevice(org.id, 'tok-kill');

    const res = await suggest({
      request: request('tok-kill', { 'accept-language': 'it' }),
    } as never);
    expect(await res.json()).toEqual({ refused: 'kill_switch', platform: 'linkedin' });
  });

  it("the wire key the route answers resolves to a real, actionable Italian sentence in the extension's own catalogue - and it differs from the English one", () => {
    // The other half of this refusal, exercised end to end (content script
    // to mounted panel) in extension/tests/content/linkedin-post-assist-locale.test.ts
    // and extension/tests/content/panel-locale-render.test.ts: this asserts
    // the two sides of the wire actually agree on the key.
    for (const reason of ['assist_disabled', 'kill_switch']) {
      const key = `assist.refusal.${reason}`;
      const en = extensionEn[key as keyof typeof extensionEn];
      const italian = extensionIt[key as keyof typeof extensionIt];
      expect(en, `dict-en.ts is missing ${key}`).toBeTruthy();
      expect(italian, `dict-it.ts is missing ${key}`).toBeTruthy();
      // Actionable: names who stopped it (a setting or an admin), not a
      // generic failure - a translation that dropped that would be a
      // regression even if grammatically correct.
      expect(en).not.toBe(key);
      expect(italian).not.toBe(key);
      expect(italian).not.toBe(en);
    }
  });
});
