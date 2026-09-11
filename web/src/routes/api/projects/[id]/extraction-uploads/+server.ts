import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, normalize, relative, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { t } from '@pitchbox/shared/messages';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const EXT_ALLOW = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.rst',
  '.json',
  '.toml',
  '.yaml',
  '.yml',
  '.html',
  '.htm',
  '.svg',
]);
const EXTLESS_ALLOW = /^(README|LICENSE|CHANGELOG|NOTICE|AUTHORS)([._-].*)?$/i;

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

type BadPathReason =
  'empty_path' | 'absolute_path' | 'invalid_characters' | 'parent_traversal' | 'path_too_long';

function isAcceptableRelPath(
  rel: string,
): { ok: true; normalized: string } | { ok: false; reason: BadPathReason } {
  if (!rel || typeof rel !== 'string') return { ok: false, reason: 'empty_path' };
  if (rel.startsWith('/')) return { ok: false, reason: 'absolute_path' };
  // Forbid backslashes too (Windows-style); we always use POSIX paths inside the upload root.
  if (rel.includes(' ') || rel.includes('\\')) return { ok: false, reason: 'invalid_characters' };
  const norm = normalize(rel);
  if (norm.startsWith('..') || norm.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: 'parent_traversal' };
  }
  if (norm.length > 256) return { ok: false, reason: 'path_too_long' };
  return { ok: true, normalized: norm };
}

function isAcceptableName(rel: string): boolean {
  const base = rel.split('/').pop() ?? '';
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) {
    return EXTLESS_ALLOW.test(base);
  }
  const ext = lower.slice(dot);
  return EXT_ALLOW.has(ext);
}

export async function POST(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });

  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');

  const db = getDb();
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  if (!project) return json({ error: 'not_found' }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(
      {
        error: 'invalid_upload',
        message: t(event.locals.locale, 'api.uploads.multipart_parse_failed'),
      },
      { status: 400 },
    );
  }

  // Collect parts that are files. The part *name* is the relative path.
  const parts: { rel: string; file: File }[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') continue;
    parts.push({ rel: name, file: value as File });
    if (parts.length > MAX_FILES) {
      return json(
        {
          error: 'too_large',
          message: t(event.locals.locale, 'api.uploads.too_many_files', { max: MAX_FILES }),
        },
        { status: 413 },
      );
    }
  }
  if (parts.length === 0) {
    return json(
      { error: 'invalid_upload', message: t(event.locals.locale, 'api.uploads.no_files') },
      { status: 400 },
    );
  }

  // Validate sizes & paths *before* writing anything.
  let total = 0;
  const accepted: { rel: string; file: File }[] = [];
  for (const p of parts) {
    if (p.file.size > MAX_FILE_BYTES) {
      return json(
        {
          error: 'too_large',
          message: t(event.locals.locale, 'api.uploads.file_too_large', {
            rel: p.rel,
            max: MAX_FILE_BYTES,
          }),
        },
        { status: 413 },
      );
    }
    total += p.file.size;
    if (total > MAX_TOTAL_BYTES) {
      return json(
        {
          error: 'too_large',
          message: t(event.locals.locale, 'api.uploads.total_too_large', { max: MAX_TOTAL_BYTES }),
        },
        { status: 413 },
      );
    }
    const v = isAcceptableRelPath(p.rel);
    if (!v.ok) {
      return json(
        {
          error: 'invalid_upload',
          message: t(event.locals.locale, 'api.uploads.bad_path', {
            rel: p.rel,
            reason: t(event.locals.locale, `api.uploads.reason.${v.reason}`),
          }),
        },
        { status: 400 },
      );
    }
    if (!isAcceptableName(v.normalized)) {
      // Silently skip files outside the allowlist - server matches the client filter.
      continue;
    }
    accepted.push({ rel: v.normalized, file: p.file });
  }

  if (accepted.length === 0) {
    return json(
      { error: 'invalid_upload', message: t(event.locals.locale, 'api.uploads.no_allowed_files') },
      { status: 400 },
    );
  }

  const root = `/tmp/pitchbox-upload-${randomUUID()}`;
  await mkdir(root, { recursive: true, mode: 0o700 });

  let bytes = 0;
  for (const a of accepted) {
    const full = resolve(root, a.rel);
    const inside = relative(root, full);
    if (inside.startsWith('..') || inside === '') {
      // Defence-in-depth: shouldn't happen given the path checks above.
      return json(
        {
          error: 'invalid_upload',
          message: t(event.locals.locale, 'api.uploads.path_escaped_root', { rel: a.rel }),
        },
        { status: 400 },
      );
    }
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    const buf = Buffer.from(await a.file.arrayBuffer());
    await writeFile(full, buf, { mode: 0o600 });
    bytes += buf.length;
  }

  return json({ path: root, files: accepted.length, bytes }, { status: 201 });
}
