import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shallowClone } from '../../src/lib/git-clone';

let srcRepo: string;

beforeAll(async () => {
  srcRepo = await mkdtemp(join(tmpdir(), 'gitsrc-'));
  execSync('git init -q -b main', { cwd: srcRepo });
  execSync('git config user.email t@t.t && git config user.name t', {
    cwd: srcRepo,
    shell: '/bin/bash',
  });
  await writeFile(join(srcRepo, 'README.md'), '# Hello');
  execSync('git add . && git commit -q -m "init"', { cwd: srcRepo, shell: '/bin/bash' });
});

afterAll(async () => {
  await rm(srcRepo, { recursive: true, force: true });
});

describe('shallowClone', () => {
  it('clones a file:// URL into the destination', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'gitdest-'));
    await rm(dest, { recursive: true });
    await shallowClone(`file://${srcRepo}`, dest);
    const out = execSync('cat README.md', { cwd: dest, encoding: 'utf8' });
    expect(out).toContain('Hello');
    await rm(dest, { recursive: true, force: true });
  });

  it('rejects empty URLs', async () => {
    await expect(shallowClone('', '/tmp/x')).rejects.toThrow(/empty/);
  });
});
