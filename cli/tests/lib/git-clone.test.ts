import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { shallowClone } from '../../src/lib/git-clone';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe('shallowClone', () => {
  it('clones an allow-listed https:// URL', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child as unknown as ReturnType<typeof spawn>;
    });
    await shallowClone('https://github.com/foo/bar.git', '/tmp/dest');
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth=1', 'https://github.com/foo/bar.git', '/tmp/dest'],
      { stdio: 'pipe' },
    );
  });

  it('clones an allow-listed git@ scp-style URL', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child as unknown as ReturnType<typeof spawn>;
    });
    await shallowClone('git@github.com:foo/bar.git', '/tmp/dest');
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth=1', 'git@github.com:foo/bar.git', '/tmp/dest'],
      { stdio: 'pipe' },
    );
  });

  it('clones an allow-listed ssh:// URL', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child as unknown as ReturnType<typeof spawn>;
    });
    await shallowClone('ssh://git@example.com/foo/bar.git', '/tmp/dest');
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth=1', 'ssh://git@example.com/foo/bar.git', '/tmp/dest'],
      { stdio: 'pipe' },
    );
  });

  it('rejects empty URLs', async () => {
    await expect(shallowClone('', '/tmp/x')).rejects.toThrow(/empty/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects the ext:: alternate transport (arbitrary command execution)', async () => {
    await expect(shallowClone('ext::sh -c touch /tmp/pwned', '/tmp/x')).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a leading-dash payload (git option injection)', async () => {
    await expect(shallowClone('--upload-pack=touch /tmp/pwned', '/tmp/x')).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects file:// URLs (not on the allow-list)', async () => {
    await expect(shallowClone('file:///etc/passwd', '/tmp/x')).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized scheme', async () => {
    await expect(shallowClone('ftp://example.com/repo.git', '/tmp/x')).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a dash-leading host smuggled into an scp-style URL (ssh option injection, CVE-2017-1000117)', async () => {
    await expect(shallowClone('git@-oProxyCommand=x:y/z.git', '/tmp/x')).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a dash-leading host in an ssh:// URL', async () => {
    await expect(shallowClone('ssh://-oProxyCommand=x/y.git', '/tmp/x')).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});
