import { json, error } from '@sveltejs/kit';
import { requireExtensionAuth, resolveDeviceOrgId } from '$lib/server/extension-auth.js';
import { getDb } from '$lib/server/db.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import {
  importLinkedinVoiceExport,
  resolveLinkedinPlatformId,
  MAX_VOICE_IMPORT_BYTES,
} from '$lib/server/voice-import.js';

// POST /api/extension/voice-import (LOR-245): the LinkedIn "Get a copy of
// your data" export importer LOR-223 shipped could previously only be
// reached from a terminal (`pitchbox voice:import`) or a browser form
// (/companion/voice's `importVoice` action) - neither is callable by
// anything that isn't a terminal or a human filling out a page, and the
// import is the step that decides whether a new customer's voice profile
// is measured or defaulted (see `operator-voice-profile.ts`'s own
// MIN_ITEMS_TO_DERIVE gate).
//
// **Auth: device bearer token, same as every other /api/extension/* route
// - not the session + `requireRole('admin')` gate /companion/voice's form
// action uses.** The two auth shapes this repo already has are a session
// cookie (`web/src/lib/server/auth.ts`) and this device token
// (`extension-auth.ts`); a third was deliberately not invented. A session
// cookie only exists after a browser login, which is exactly what "a
// customer can automate their own re-import" (the issue's own framing,
// ahead of the extension use case) cannot assume. A device token can:
// `POST /api/extension/pair` already mints one from nothing but a pairing
// code generated in Settings, with no extension install involved (see
// `extension-devices`' own pairing flow) - it is already this app's
// closest thing to a personal access token for headless scripting, and
// it's also the exact credential the extension itself already carries.
// One route, one auth shape, usable by both callers the issue names.
// `requireRole`'s admin gate has no equivalent here on purpose: a device
// token is not a user session and carries no role, only an org binding
// (`resolveDeviceOrgId`) - the same posture every other /api/extension/*
// write route (`observations`, `operator-profile`) already takes for
// org-scoped writes.
//
// **Body is the raw archive, not a multipart form.** An automating caller
// posts the file's bytes directly; `Content-Type` says which shape they
// are (`application/zip` / `application/x-zip-compressed` for the export
// zip, `text/csv` for an already-extracted `Shares.csv`/`Comments.csv`),
// since `parseLinkedinExportBuffer`'s own dispatch needs a filename
// extension and there is no multipart field name to read one from here.
//
// **Size cap enforced before buffering, not after.** Same
// `MAX_VOICE_IMPORT_BYTES` the companion form applies (now shared from
// `$lib/server/voice-import.js` so the two can't drift). `Content-Length`
// is checked first and refuses without touching the body at all; the
// stream is then read in bounded chunks and aborted the moment the running
// total would exceed the cap, so a request with no (or a lying)
// `Content-Length` still can't force an oversized buffer into memory.
//
// **Response is a full accounting, not `{ok:true}`.** See
// `VoiceImportOutcome` (`$lib/server/voice-import.js`): rows landed per
// genre, rows already on file (dedup), rows dropped as textless
// reposts/reactions, and the corpus's `MIN_ITEMS_TO_DERIVE` status per
// genre after the import. Re-posting the same archive is the normal case,
// not an error - `noop`/`message` make that an explicit, readable outcome
// rather than an ambiguous 200.
//
// **No plan-limit gate.** Unlike `/api/extension/observations` and
// `/suggest`, an import doesn't spend the org's suggestion budget or touch
// billing-gated output - it only fills the operator's own voice corpus -
// so there is nothing here for `isOrgReadOnly`/the suggestion quota to
// refuse. Nothing was added to imitate one.

const perDevice = new RateLimiter(10, 60_000);

/** Static lookup: an accepted `Content-Type` to the synthetic filename
 * `parseLinkedinExportBuffer`'s own extension-based dispatch needs, since
 * there's no multipart field name to read a real one from here. */
const FILENAME_BY_CONTENT_TYPE: Record<string, string> = {
  'application/zip': 'export.zip',
  'application/x-zip-compressed': 'export.zip',
  'text/csv': 'export.csv',
};

function filenameForContentType(contentType: string): string | null {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return FILENAME_BY_CONTENT_TYPE[type] ?? null;
}

const oversizedMessage = (maxBytes: number) =>
  `File exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit.`;

/**
 * Reads `request`'s body into a `Buffer`, refusing (413) as soon as it's
 * clear the body exceeds `maxBytes` - before a client-declared
 * `Content-Length` is trusted at all, and again while streaming so a
 * missing or understated header can't force a full oversized buffer into
 * memory before this notices.
 */
async function readCappedBody(request: Request, maxBytes: number): Promise<Buffer> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) throw error(413, oversizedMessage(maxBytes));
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw error(413, oversizedMessage(maxBytes));
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);
  if (!perDevice.consume(`device:${auth.deviceId}`)) throw error(429, 'too many imports');

  const filename = filenameForContentType(request.headers.get('content-type') ?? '');
  if (!filename) {
    throw error(
      400,
      'Set Content-Type to application/zip (a LinkedIn export archive) or text/csv (a single Shares.csv/Comments.csv).',
    );
  }

  const buffer = await readCappedBody(request, MAX_VOICE_IMPORT_BYTES);
  if (buffer.length === 0) {
    throw error(400, 'Empty body - post the export archive or CSV as raw bytes.');
  }

  const db = getDb();
  const orgId = await resolveDeviceOrgId(db, auth.organizationId);
  if (orgId == null) throw error(404, 'not_found');

  // A missing LinkedIn platform row is a server misconfiguration (the seed
  // that creates it never ran), not a bad request - kept as its own check
  // so it 500s instead of being mistaken for an unparseable file below.
  const platformId = await resolveLinkedinPlatformId(db);
  if (platformId == null) throw error(500, 'LinkedIn platform is not configured.');

  let outcome;
  try {
    outcome = await importLinkedinVoiceExport(db, orgId, platformId, buffer, filename);
  } catch (err) {
    // Everything parseLinkedinExportBuffer itself throws - not an archive,
    // or an archive with neither Shares.csv nor Comments.csv - is a bad
    // request with a message already written to be read, never a stack
    // trace or a bare 500.
    throw error(400, err instanceof Error ? err.message : 'Could not read that file.');
  }

  return json({ ok: true, ...outcome });
}
