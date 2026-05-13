import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '../../src/db/client.js';
import { loadRunnerConfigs, loadRunnerConfig, saveRunnerConfig } from '../../src/agents/config.js';

async function reset() {
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'runner_configs'`);
}

describe('shared/agents/config', () => {
  beforeEach(reset);

  it('returns an empty config per runner when nothing is persisted', async () => {
    const all = await loadRunnerConfigs(getDb());
    expect(all['claude-code']).toEqual({});
    expect(all['codex']).toEqual({});
    expect(all['opencode']).toEqual({});
    expect(await loadRunnerConfig(getDb(), 'claude-code')).toEqual({});
  });

  it('saveRunnerConfig persists per-runner and leaves other slugs untouched', async () => {
    await saveRunnerConfig(getDb(), 'claude-code', {
      model: 'claude-sonnet-4-6',
      maxTurns: 12,
    });
    const all = await loadRunnerConfigs(getDb());
    expect(all['claude-code']).toEqual({ model: 'claude-sonnet-4-6', maxTurns: 12 });
    expect(all['codex']).toEqual({});

    await saveRunnerConfig(getDb(), 'codex', { extraArgs: ['--verbose'] });
    const after = await loadRunnerConfigs(getDb());
    expect(after['claude-code']).toEqual({ model: 'claude-sonnet-4-6', maxTurns: 12 });
    expect(after['codex']).toEqual({ extraArgs: ['--verbose'] });
  });
});

afterAll(async () => {
  await getPool().end();
});
