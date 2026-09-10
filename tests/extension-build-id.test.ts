import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveBuildId } from '../extension/vite-plugins/build-id';

/**
 * The identity a locally built bundle carries. The env path is exercised by
 * `tests/extension-packaged-build.test.ts` on the real artifact; this covers
 * the path every hand-built preview bundle actually takes, which is the
 * checkout.
 */

const repos: string[] = [];

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pitchbox-build-id-'));
  repos.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'first');
  return dir;
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.PITCHBOX_BUILD_ID;
});

describe('resolveBuildId', () => {
  it('names the commit the bundle was built from', () => {
    expect(resolveBuildId(repo())).toMatch(/^[0-9a-f]{7}$/);
  });

  it('marks a bundle built from a modified tree, which is not the commit it names', () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    expect(resolveBuildId(dir)).toMatch(/^[0-9a-f]{7}-dirty$/);
  });

  it('prefers an explicitly supplied id, for a build with no checkout', () => {
    process.env.PITCHBOX_BUILD_ID = 'ci-1234';
    expect(resolveBuildId(repo())).toBe('ci-1234');
  });
});
