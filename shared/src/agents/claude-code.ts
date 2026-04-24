import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunOptions, AgentRunResult, AgentRunner } from './base.js';

type SpawnFn = typeof nodeSpawn;

export interface ClaudeCodeRunnerOptions {
  binary?: string;
  spawn?: SpawnFn;
  logDir?: string;
}

export class ClaudeCodeRunner implements AgentRunner {
  readonly slug = 'claude-code';
  private readonly binary: string;
  private readonly spawn: SpawnFn;
  private readonly logDir: string;

  constructor(opts: ClaudeCodeRunnerOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.spawn = opts.spawn ?? nodeSpawn;
    this.logDir = opts.logDir ?? join(process.cwd(), 'daemon', 'logs');
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const skillDir = join(opts.cwd, '.claude', 'skills', opts.slug);
    mkdirSync(skillDir, { recursive: true });
    const playbook = await readFile(opts.playbookPath, 'utf8');
    const frontmatter = `---\nname: ${opts.slug}\ndescription: Pitchbox playbook ${opts.slug}\n---\n\n`;
    writeFileSync(join(skillDir, 'SKILL.md'), frontmatter + playbook, 'utf8');

    mkdirSync(this.logDir, { recursive: true });
    const logPath = join(this.logDir, `run-${Date.now()}-${opts.slug}.log`);

    const prompt = `Invoke the '${opts.slug}' skill for campaign ${opts.env.PITCHBOX_CAMPAIGN_ID ?? ''}. The skill knows what to do.`;

    let tokensUsed: number | undefined;

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = this.spawn(
          this.binary,
          [
            '-p',
            prompt,
            '--dangerously-skip-permissions',
            '--verbose',
            '--output-format',
            'stream-json',
          ],
          { cwd: opts.cwd, env: { ...process.env, ...opts.env } },
        );
        const chunks: string[] = [];
        let buffer = '';

        const emitLine = (line: string) => {
          if (!line) return;
          opts.onLogLine?.(line);
          // Extract token usage from the final result event.
          try {
            const evt = JSON.parse(line);
            if (evt?.type === 'result' && typeof evt.usage === 'object') {
              tokensUsed =
                (evt.usage.input_tokens ?? 0) + (evt.usage.output_tokens ?? 0) || undefined;
            }
          } catch {
            // Not JSON, ignore.
          }
        };

        child.stdout?.on('data', (d: Buffer) => {
          const s = d.toString('utf8');
          chunks.push(s);
          buffer += s;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) emitLine(line);
        });
        child.stderr?.on('data', (d: Buffer) => {
          const s = d.toString('utf8');
          chunks.push(s);
          opts.onLogLine?.(`[stderr] ${s.trimEnd()}`);
        });

        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`agent run timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
        child.on('exit', (code: number | null) => {
          clearTimeout(timer);
          if (buffer) emitLine(buffer);
          writeFileSync(logPath, chunks.join(''), 'utf8');
          resolve(code ?? 1);
        });
        child.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return { exitCode, logPath, tokensUsed };
    } finally {
      if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
    }
  }
}
