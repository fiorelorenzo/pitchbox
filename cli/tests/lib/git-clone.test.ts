import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { shallowClone } from '../../src/lib/git-clone';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

// This box's own shell exports `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`, and the
// clone environment is built on top of whatever is ambient, so every test
// here starts from a known-empty set and puts back what it found.
const AMBIENT_KEYS = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
let ambient: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  ambient = {};
  for (const key of AMBIENT_KEYS) {
    ambient[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AMBIENT_KEYS) {
    if (ambient[key] === undefined) delete process.env[key];
    else process.env[key] = ambient[key];
  }
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
      expect.objectContaining({ stdio: 'pipe' }),
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
      expect.objectContaining({ stdio: 'pipe' }),
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
      expect.objectContaining({ stdio: 'pipe' }),
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

  // #390's credential reaches the clone, and the two rules that make it safe
  // to carry one: it never appears in argv (world-readable through
  // /proc/<pid>/cmdline) and never in the URL (which git echoes back in its
  // own error text), and the header is scoped to the clone URL's own origin
  // so a redirect elsewhere cannot pick it up.
  it('presents an installation token as an origin-scoped header in the environment, never in argv', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child as unknown as ChildProcess;
    });
    await shallowClone('https://github.com/foo/private.git', '/tmp/dest', {
      credential: { username: 'x-access-token', token: 'ghs_secret' },
    });

    const [, argv, options] = vi.mocked(spawn).mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string | undefined> },
    ];
    expect(argv).toEqual(['clone', '--depth=1', 'https://github.com/foo/private.git', '/tmp/dest']);
    expect(argv.join(' ')).not.toContain('ghs_secret');

    const { env } = options;
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from('x-access-token:ghs_secret').toString('base64')}`,
    );
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('sends no credential header when there is no installation to mint one from', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child as unknown as ChildProcess;
    });
    await shallowClone('https://github.com/foo/bar.git', '/tmp/dest');

    const options = vi.mocked(spawn).mock.calls[0][2] as unknown as {
      env: Record<string, string | undefined>;
    };
    expect(options.env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(options.env.GIT_CONFIG_COUNT).toBeUndefined();
    // Still refuses to block on an interactive credential prompt.
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  // A box whose own environment carries `GIT_CONFIG_*` pairs (this one does)
  // must keep them: overwriting index 0 would silently drop an operator's
  // git configuration for the duration of the clone.
  it('extends the ambient GIT_CONFIG_* pairs instead of overwriting them', async () => {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'url.git@github.com:.insteadof';
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
    const child = makeFakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child as unknown as ChildProcess;
    });
    await shallowClone('https://github.com/foo/private.git', '/tmp/dest', {
      credential: { username: 'x-access-token', token: 'ghs_secret' },
    });

    const { env } = vi.mocked(spawn).mock.calls[0][2] as unknown as {
      env: Record<string, string | undefined>;
    };
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('url.git@github.com:.insteadof');
    expect(env.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraheader');
    expect(env.GIT_CONFIG_VALUE_1).toContain('Authorization: Basic ');
  });
});
