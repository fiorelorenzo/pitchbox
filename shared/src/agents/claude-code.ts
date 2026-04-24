import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunHandle, AgentRunOptions, AgentRunResult, AgentRunner } from './base.js';
import { parseClaudeCodeLine } from '../runlog/parsers/claude-code.js';

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

  run(opts: AgentRunOptions): AgentRunHandle {
    const skillDir = join(opts.cwd, '.claude', 'skills', opts.slug);

    let cancelFn: () => void = () => {};

    const result: Promise<AgentRunResult> = (async () => {
      mkdirSync(skillDir, { recursive: true });
      const playbook = await readFile(opts.playbookPath, 'utf8');
      const frontmatter = `---\nname: ${opts.slug}\ndescription: Pitchbox playbook ${opts.slug}\n---\n\n`;
      writeFileSync(join(skillDir, 'SKILL.md'), frontmatter + playbook, 'utf8');

      mkdirSync(this.logDir, { recursive: true });
      const logPath = join(this.logDir, `run-${Date.now()}-${opts.slug}.log`);

      const prompt = `Invoke the '${opts.slug}' skill for campaign ${opts.env.PITCHBOX_CAMPAIGN_ID ?? ''}. The skill knows what to do.`;

      let tokensUsed: number | undefined;
      // Per-run sequence counter — monotonically increasing, owned by this runner.
      let seq = 0;

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
            {
              cwd: opts.cwd,
              env: { ...process.env, ...opts.env },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );

          // Register cancel function now that we have the child.
          cancelFn = () => {
            child.kill('SIGTERM');
            const killTimer = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {
                // Already gone.
              }
            }, 5000);
            // Clear the kill timer if the child exits before the 5s.
            child.once('exit', () => clearTimeout(killTimer));
          };

          // Stream-log: append mode so we can inspect progress mid-run via `tail -f`.
          writeFileSync(
            logPath,
            `# run ${opts.slug} started ${new Date().toISOString()}\n`,
            'utf8',
          );
          let buffer = '';

          const emitLine = (line: string) => {
            if (!line) return;
            appendFileSync(logPath, line + '\n', 'utf8');
            console.log(`[claude-code ${opts.slug}] ${line.slice(0, 200)}`);
            opts.onRawLine?.(line);

            // Format-native parsing → normalized events.
            const events = parseClaudeCodeLine(line, seq);
            if (events.length > 0) {
              seq += events.length;
            } else {
              // Advance seq even for unrecognised lines so downstream can't collide
              // with a future parsed event.
              seq += 1;
            }

            // Extract token usage from a final 'result' event.
            for (const e of events) {
              if (e.kind === 'result' && e.payload?.type === 'result') {
                const r = e.payload;
                tokensUsed = (r.inputTokens ?? 0) + (r.outputTokens ?? 0) || tokensUsed;
              }
            }

            if (events.length > 0) {
              // Fire-and-forget; the caller may await if it wants.
              void opts.onParsedEvents?.(events);
            }
          };

          child.stdout?.on('data', (d: Buffer) => {
            const s = d.toString('utf8');
            buffer += s;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) emitLine(line);
          });
          child.stderr?.on('data', (d: Buffer) => {
            const s = d.toString('utf8');
            appendFileSync(logPath, `[stderr] ${s}`, 'utf8');
            opts.onRawLine?.(`[stderr] ${s.trimEnd()}`);
          });

          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`agent run timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs);
          child.on('exit', (code: number | null) => {
            clearTimeout(timer);
            if (buffer) emitLine(buffer);
            appendFileSync(logPath, `\n# exit ${code} at ${new Date().toISOString()}\n`, 'utf8');
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
    })();

    return {
      result,
      cancel: () => cancelFn(),
    };
  }
}
