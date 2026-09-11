import { describe, it, expect } from 'vitest';
import { restoreEnv } from './setup-env';

/**
 * The containment in `tests/setup-env.ts` is what keeps one file's
 * `PITCHBOX_EDITION` out of the next file's run (LOR-217). Its own behaviour
 * is asserted against a plain object rather than the real `process.env`, so
 * this test cannot itself become the leak it exists to prevent.
 */

describe('restoreEnv', () => {
  it('removes a key the file added', () => {
    const env: Record<string, string | undefined> = { KEEP: 'a' };
    const snapshot = { ...env };
    env.PITCHBOX_EDITION = 'cloud';
    restoreEnv(snapshot, env);
    expect(env).toEqual({ KEEP: 'a' });
  });

  it('puts back a key the file changed, and one it deleted', () => {
    const env: Record<string, string | undefined> = { EDITION: 'self-hosted', TOKEN: 'x' };
    const snapshot = { ...env };
    env.EDITION = 'cloud';
    delete env.TOKEN;
    restoreEnv(snapshot, env);
    expect(env).toEqual({ EDITION: 'self-hosted', TOKEN: 'x' });
  });

  it('leaves an untouched environment alone', () => {
    const env: Record<string, string | undefined> = { A: '1', B: '2' };
    const snapshot = { ...env };
    restoreEnv(snapshot, env);
    expect(env).toEqual({ A: '1', B: '2' });
  });
});
