// #220: the extraction agent runs on the cloud runner, where the source tree
// does not exist - it lives on this client. These two tools are how it reads
// the source instead of its own Read/Glob/Bash, so they have to be both usable
// (relative paths, sizes, truncation) and sealed (nothing outside the root).
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { sql } from 'drizzle-orm';
import { projectExtractListFiles, projectExtractReadFile } from '../../src/commands/project.js';

async function reset() {
  await getDb().execute(sql`TRUNCATE runs, projects RESTART IDENTITY CASCADE`);
}

describe('project extraction source access (#220)', () => {
  let runId: number;
  let folder: string;
  let outside: string;

  beforeEach(async () => {
    await reset();
    const db = getDb();
    folder = await mkdtemp(join(tmpdir(), 'pbsrc-'));
    outside = await mkdtemp(join(tmpdir(), 'pbout-'));
    await writeFile(join(outside, 'secret.txt'), 'do not leak me');
    await writeFile(join(folder, 'README.md'), '# Test project\n\nIt does things.\n');
    await mkdir(join(folder, 'docs'));
    await writeFile(join(folder, 'docs', 'guide.md'), 'guide');
    await mkdir(join(folder, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(folder, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1');
    await mkdir(join(folder, '.git'));
    await writeFile(join(folder, '.git', 'config'), '[core]');

    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p1', name: 'P1' })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId: project.id,
        trigger: 'manual',
        status: 'running',
        params: { source: { kind: 'folder', value: folder } },
      })
      .returning();
    runId = run.id;
  });

  it('lists source files as relative paths, skipping build and VCS noise', async () => {
    const out = await projectExtractListFiles(runId);
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain(join('docs', 'guide.md'));
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
    expect(out.truncated).toBe(false);
    expect(out.files.find((f) => f.path === 'README.md')?.bytes).toBeGreaterThan(0);
  });

  it('reads a file by its relative path', async () => {
    const out = await projectExtractReadFile(runId, 'README.md');
    expect(out.content).toMatch(/# Test project/);
    expect(out.truncated).toBe(false);
    expect(out.path).toBe('README.md');
  });

  it('truncates a file past the read cap but reports its real size', async () => {
    const big = 'x'.repeat(250_000);
    await writeFile(join(folder, 'big.txt'), big);
    const out = await projectExtractReadFile(runId, 'big.txt');
    expect(out.bytes).toBe(250_000);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBe(200_000);
  });

  it('refuses a path that climbs out of the source root', async () => {
    await expect(projectExtractReadFile(runId, '../../etc/passwd')).rejects.toThrow(/escapes/);
  });

  it('refuses an absolute path', async () => {
    await expect(projectExtractReadFile(runId, join(outside, 'secret.txt'))).rejects.toThrow(
      /relative/,
    );
  });

  it('refuses a symlink pointing outside the source root', async () => {
    await symlink(join(outside, 'secret.txt'), join(folder, 'escape.txt'));
    await expect(projectExtractReadFile(runId, 'escape.txt')).rejects.toThrow(/escapes/);
    const listed = await projectExtractListFiles(runId);
    expect(listed.files.some((f) => f.path === 'escape.txt')).toBe(false);
  });

  it('refuses a run that is not a project extraction', async () => {
    const db = getDb();
    const [project] = await db.select().from(schema.projects);
    const [other] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_insights',
        projectId: project.id,
        trigger: 'manual',
        status: 'running',
        params: {},
      })
      .returning();
    await expect(projectExtractListFiles(other.id)).rejects.toThrow(/not a project_extraction/);
  });
});

afterAll(async () => {
  await getPool().end();
});
