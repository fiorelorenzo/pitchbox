import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, normalize, relative, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

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

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isAcceptableRelPath(
  rel: string,
): { ok: true; normalized: string } | { ok: false; reason: string } {
  if (!rel || typeof rel !== 'string') return { ok: false, reason: 'empty path' };
  if (rel.startsWith('/')) return { ok: false, reason: 'absolute path' };
  // Forbid backslashes too (Windows-style); we always use POSIX paths inside the upload root.
  if (rel.includes(' ') || rel.includes('\\')) return { ok: false, reason: 'invalid characters' };
  const norm = normalize(rel);
  if (norm.startsWith('..') || norm.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: 'parent traversal' };
  }
  if (norm.length > 256) return { ok: false, reason: 'path too long' };
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

export async function POST({ params, request }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });

  const db = getDb();
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  if (!project) return json({ error: 'not_found' }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'invalid_upload', message: 'multipart parse failed' }, { status: 400 });
  }

  // Collect parts that are files. The part *name* is the relative path.
  const parts: { rel: string; file: File }[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') continue;
    parts.push({ rel: name, file: value as File });
    if (parts.length > MAX_FILES) {
      return json({ error: 'too_large', message: `max ${MAX_FILES} files` }, { status: 413 });
    }
  }
  if (parts.length === 0) {
    return json({ error: 'invalid_upload', message: 'no files in request' }, { status: 400 });
  }

  // Validate sizes & paths *before* writing anything.
  let total = 0;
  const accepted: { rel: string; file: File }[] = [];
  for (const p of parts) {
    if (p.file.size > MAX_FILE_BYTES) {
      return json(
        {
          error: 'too_large',
          message: `${p.rel} exceeds per-file ${MAX_FILE_BYTES}B cap`,
        },
        { status: 413 },
      );
    }
    total += p.file.size;
    if (total > MAX_TOTAL_BYTES) {
      return json(
        { error: 'too_large', message: `total upload exceeds ${MAX_TOTAL_BYTES}B cap` },
        { status: 413 },
      );
    }
    const v = isAcceptableRelPath(p.rel);
    if (!v.ok) {
      return json(
        { error: 'invalid_upload', message: `bad path "${p.rel}": ${v.reason}` },
        { status: 400 },
      );
    }
    if (!isAcceptableName(v.normalized)) {
      // Silently skip files outside the allowlist — server matches the client filter.
      continue;
    }
    accepted.push({ rel: v.normalized, file: p.file });
  }

  if (accepted.length === 0) {
    return json(
      { error: 'invalid_upload', message: 'no allowed files in upload' },
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
          message: `path resolution escaped root: ${a.rel}`,
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
