import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../../src/agents/claude-code.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

describe('ClaudeCodeRunner', () => {
  it('installs playbook as a skill and removes it after run', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pitchbox-'));
    const playbook = join(cwd, 'playbook.md');
    writeFileSync(playbook, 'Do a thing.');

    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    const runner = new ClaudeCodeRunner({
      spawn: ((cmd: string, args: string[], _opts: any) => {
        spawnCalls.push({ cmd, args });
        // Confirm skill file exists at the moment spawn is called.
        const skillPath = join(cwd, '.claude', 'skills', 'test-skill', 'SKILL.md');
        expect(readFileSync(skillPath, 'utf8')).toContain('Do a thing.');

        const emitter: any = new EventEmitter();
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.kill = () => {};
        setImmediate(() => emitter.emit('exit', 0));
        return emitter;
      }) as any,
    });

    const handle = runner.run({
      playbookPath: playbook,
      slug: 'test-skill',
      env: { PITCHBOX_CAMPAIGN_ID: '1' },
      cwd,
      timeoutMs: 5000,
    });
    expect(typeof handle.cancel).toBe('function');
    const res = await handle.result;
    expect(res.exitCode).toBe(0);
    expect(() => readFileSync(join(cwd, '.claude', 'skills', 'test-skill', 'SKILL.md'))).toThrow();
    expect(spawnCalls[0].cmd).toBe('claude');
    expect(spawnCalls[0].args).toContain('--dangerously-skip-permissions');

    rmSync(cwd, { recursive: true, force: true });
  });
});
