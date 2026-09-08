import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from '@pitchbox/shared/db';
import { POST as runPost } from '../src/routes/api/run/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

// Captured before runThroughHandle's first call sets PITCHBOX_AUTH='on', so
// afterAll can restore it and this file doesn't leak into other test files
// sharing this worker. PITCHBOX_INTERNAL_TOKEN is deliberately left unset in
// this file - that is the scenario under test, and a separate test file
// (internal-dispatch-auth.test.ts) covers the configured-secret cases. Both
// need their own file because hooks.server.ts reads PITCHBOX_INTERNAL_TOKEN
// into a module-level constant at import time - one file can't observe two
// different values of it.
const originalAuth = process.env.PITCHBOX_AUTH;

const UNKNOWN_CAMPAIGN_ID = 999_999_999;
const emptyJar: CookieJar = { store: new Map() };

// #378 option 1's acceptance is scoped to "only when the secret is
// configured". An unset PITCHBOX_INTERNAL_TOKEN must not accidentally open
// POST /api/run to anyone who guesses a plausible-looking bearer token - the
// route has to stay exactly as closed as it was before this feature existed.
describe('POST /api/run with PITCHBOX_INTERNAL_TOKEN unset (real handle + route)', () => {
  it('no session, with a token supplied, still gets 401 - not treated as internal dispatch', async () => {
    const req = new Request('http://localhost/api/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer some-plausible-looking-secret-value',
      },
      body: JSON.stringify({ campaignId: UNKNOWN_CAMPAIGN_ID, trigger: 'scheduled' }),
    });
    const res = await runThroughHandle(req, emptyJar, runPost as any);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthenticated');
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getPool().end();
});
