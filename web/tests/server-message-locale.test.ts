import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { clearDetectionCache } from '@pitchbox/shared/agents/detect';
import { POST as projectsPost } from '../src/routes/api/projects/+server.js';
import { PATCH as projectsPatch } from '../src/routes/api/projects/[id]/+server.js';
import { POST as campaignsPost } from '../src/routes/api/campaigns/+server.js';
import { PATCH as campaignsPatch } from '../src/routes/api/campaigns/[id]/+server.js';
import { POST as extractionUploadsPost } from '../src/routes/api/projects/[id]/extraction-uploads/+server.js';
import { POST as register } from '../src/routes/api/auth/register/+server.js';
import { saveRegistrationPolicy } from '@pitchbox/shared/registration-policy';
import { type CookieJar, makeCookies } from './helpers/handle-harness.js';

/**
 * LOR-264: acceptance bullet 1 - every server-sent string a user can read
 * resolves through the catalogue (`@pitchbox/shared/messages`), the machine
 * key stays put, and an Italian request never gets a raw English sentence
 * back. One case per catalogued route; the mail templates and the assist
 * plane's key-only refusal have their own files
 * (org-invite-mail.test.ts/extension-suggest-refusal-locale.test.ts).
 */

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function defaultOrgId(): Promise<number> {
  const [org] = await getDb()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  return org.id;
}

async function seedProject(orgId: number, name: string): Promise<number> {
  const [project] = await getDb()
    .insert(schema.projects)
    .values({ organizationId: orgId, slug: name, name })
    .returning();
  return project.id;
}

function postEvent<T>(orgId: number, body: unknown, locale: 'en' | 'it'): T {
  return {
    locals: { org: { id: orgId, slug: 'default', role: 'owner' }, locale },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as T;
}

function patchEvent<T>(orgId: number, id: number, body: unknown, locale: 'en' | 'it'): T {
  return {
    locals: { org: { id: orgId, slug: 'default', role: 'owner' }, locale },
    params: { id: String(id) },
    request: new Request(`http://x/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  } as unknown as T;
}

describe('runner_not_allowed message: same key, translated sentence (#219/#410)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
    clearDetectionCache();
  });

  it('POST /api/projects: Italian body names the runner and never falls back to English', async () => {
    const orgId = await defaultOrgId();
    const res = await projectsPost(
      postEvent(orgId, { name: 'p-it', defaultAgentRunner: 'claude-code' }, 'it'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('runner_not_allowed');
    expect(body.message).toContain('claude-code');
    expect(body.message).toContain('non è disponibile');
    expect(body.message).not.toMatch(/is not available/);
  });

  it('POST /api/projects: English body for an English request, same key as the Italian one', async () => {
    const orgId = await defaultOrgId();
    const res = await projectsPost(
      postEvent(orgId, { name: 'p-en', defaultAgentRunner: 'claude-code' }, 'en'),
    );
    const body = await res.json();
    expect(body.error).toBe('runner_not_allowed');
    expect(body.message).toBe(
      'Agent runner "claude-code" is not available in this deployment\'s edition.',
    );
  });

  it('PATCH /api/projects/[id]: Italian body, same error key as English', async () => {
    const orgId = await defaultOrgId();
    const projectId = await seedProject(orgId, 'p-patch-it');
    const res = await projectsPatch(
      patchEvent(orgId, projectId, { defaultAgentRunner: 'codex' }, 'it'),
    );
    const body = await res.json();
    expect(body.error).toBe('runner_not_allowed');
    expect(body.message).toContain('codex');
    expect(body.message).toContain('non è disponibile');
  });

  it('POST /api/campaigns: Italian body names the runner', async () => {
    const orgId = await defaultOrgId();
    const projectId = await seedProject(orgId, 'p-camp-it');
    const res = await campaignsPost(
      postEvent(
        orgId,
        {
          projectId,
          platformSlug: 'reddit',
          scenarioSlug: 'reddit-scout',
          name: 'c',
          objective: 'find people',
          agentRunner: 'gemini',
        },
        'it',
      ),
    );
    const body = await res.json();
    expect(body.error).toBe('runner_not_allowed');
    expect(body.message).toContain('gemini');
    expect(body.message).toContain('non è disponibile');
  });

  it('PATCH /api/campaigns/[id]: Italian body, same error key as English', async () => {
    const orgId = await defaultOrgId();
    const projectId = await seedProject(orgId, 'p-camp-patch-it');
    const [platform] = await getDb()
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [campaign] = await getDb()
      .insert(schema.campaigns)
      .values({ projectId, platformId: platform.id, name: 'c', skillSlug: 'reddit-scout' })
      .returning();
    const res = await campaignsPatch(
      patchEvent(orgId, campaign.id, { agentRunner: 'opencode' }, 'it'),
    );
    const body = await res.json();
    expect(body.error).toBe('runner_not_allowed');
    expect(body.message).toContain('opencode');
    expect(body.message).toContain('non è disponibile');
  });
});

describe('custom tone message: same key, translated sentence', () => {
  beforeEach(reset);

  it('PATCH /api/projects/[id]: Italian body for a custom tone with no notes', async () => {
    const orgId = await defaultOrgId();
    const projectId = await seedProject(orgId, 'p-tone-it');
    const res = await projectsPatch(
      patchEvent(orgId, projectId, { voiceTone: 'custom', voiceToneNotes: '   ' }, 'it'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(body.message).toContain('Descrivi il tono');
  });

  it('PATCH /api/projects/[id]: English body, same key as Italian', async () => {
    const orgId = await defaultOrgId();
    const projectId = await seedProject(orgId, 'p-tone-en');
    const res = await projectsPatch(
      patchEvent(orgId, projectId, { voiceTone: 'custom', voiceToneNotes: '' }, 'en'),
    );
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(body.message).toBe('Describe the tone you want, or pick "Use organization default".');
  });
});

describe('registration refusal message: same key, translated sentence (#505)', () => {
  const originalAuth = process.env.PITCHBOX_AUTH;
  beforeEach(async () => {
    process.env.PITCHBOX_AUTH = 'on';
    await getDb().execute(sql`DELETE FROM app_config WHERE key = 'registration_policy'`);
  });
  afterEach(() => {
    if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
    else process.env.PITCHBOX_AUTH = originalAuth;
  });

  function registerEvent(body: unknown, locale: 'en' | 'it'): RequestEvent {
    const jar: CookieJar = { store: new Map() };
    const request = new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      request,
      url: new URL(request.url),
      cookies: makeCookies(jar),
      getClientAddress: () => '10.50.0.1',
      locals: { locale },
    } as unknown as RequestEvent;
  }

  it('registration_closed answers an actionable Italian sentence, same key as English', async () => {
    await saveRegistrationPolicy(getDb(), 'off');
    const res = await register(
      registerEvent(
        { username: 'x', email: 'x@example.com', password: 'a-very-long-password' },
        'it',
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('registration_closed');
    expect(body.message).toContain('disabilitata');
    expect(body.message).not.toMatch(/disabled/);
  });

  it('invite_required answers an actionable Italian sentence, same key as English', async () => {
    await saveRegistrationPolicy(getDb(), 'invite');
    const res = await register(
      registerEvent(
        { username: 'y', email: 'y@example.com', password: 'a-very-long-password' },
        'it',
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('invite_required');
    expect(body.message).toContain('invito');
  });
});

describe('extraction-uploads messages: same key, translated sentence', () => {
  beforeEach(reset);

  function uploadEvent(
    orgId: number,
    id: number,
    form: FormData,
    locale: 'en' | 'it',
  ): RequestEvent {
    return {
      locals: { org: { id: orgId, slug: 'default', role: 'owner' }, locale },
      params: { id: String(id) },
      request: new Request(`http://x/${id}`, { method: 'POST', body: form }),
    } as unknown as RequestEvent;
  }

  it('no files in the request: Italian message, same key as English', async () => {
    const orgId = await defaultOrgId();
    const projectId = await seedProject(orgId, 'p-upload-empty');
    const res = await extractionUploadsPost(uploadEvent(orgId, projectId, new FormData(), 'it'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_upload');
    expect(body.message).toBe('nessun file nella richiesta');
  });

  it('a file that fails the path check: Italian composed message names the reason', async () => {
    const orgId = await defaultOrgId();
    const projectId = await seedProject(orgId, 'p-upload-badpath');
    const form = new FormData();
    form.set('../escape.md', new File(['hi'], 'escape.md', { type: 'text/markdown' }));
    const res = await extractionUploadsPost(uploadEvent(orgId, projectId, form, 'it'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_upload');
    // Composed from two catalogue keys (`bad_path` + the reason code) -
    // both must have resolved to Italian, not just the outer one.
    expect(body.message).toContain('percorso non valido');
    expect(body.message).toContain('tentativo di uscire dalla cartella');
  });

  it('the same bad-path case in English carries the same error key, different sentence', async () => {
    const orgId = await defaultOrgId();
    const projectId = await seedProject(orgId, 'p-upload-badpath-en');
    const form = new FormData();
    form.set('../escape.md', new File(['hi'], 'escape.md', { type: 'text/markdown' }));
    const res = await extractionUploadsPost(uploadEvent(orgId, projectId, form, 'en'));
    const body = await res.json();
    expect(body.error).toBe('invalid_upload');
    expect(body.message).toBe('bad path "../escape.md": parent traversal');
  });
});
