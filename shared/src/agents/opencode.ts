import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunHandle, AgentRunOptions, AgentRunResult, AgentRunner } from './base.js';
import { parseOpenCodeLine } from '../runlog/parsers/opencode.js';
import { computeCostUsd } from '../runlog/usage.js';
import type { RunnerConfig } from './config.js';

type SpawnFn = typeof nodeSpawn;

export interface OpenCodeRunnerOptions {
  binary?: string;
  spawn?: SpawnFn;
  logDir?: string;
  config?: RunnerConfig;
}

/**
 * OpenCode CLI runner. Spawns `opencode run --json <prompt>` and pipes
 * stdout through `parseOpenCodeLine`.
 *
 * ASSUMED INVOCATION: `opencode run --json <prompt>` (from sst/opencode).
 * Model is passed via `--model <model>` when configured; default assumed
 * model is `opencode-default`.
 */
export class OpenCodeRunner implements AgentRunner {
  readonly slug = 'opencode';
  private readonly binary: string;
  private readonly spawn: SpawnFn;
  private readonly logDir: string;
  private readonly config: RunnerConfig;

  constructor(opts: OpenCodeRunnerOptions = {}) {
    this.binary = opts.binary ?? 'opencode';
    this.spawn = opts.spawn ?? nodeSpawn;
    this.logDir = opts.logDir ?? join(process.cwd(), 'daemon', 'logs');
    this.config = opts.config ?? {};
  }

  run(opts: AgentRunOptions): AgentRunHandle {
    let cancelFn: () => void = () => {};

    const result: Promise<AgentRunResult> = (async () => {
      mkdirSync(this.logDir, { recursive: true });
      const logPath = join(this.logDir, `run-${Date.now()}-${opts.slug}.log`);

      const playbook = await readFile(opts.playbookPath, 'utf8');
      const prompt =
        `You are running the Pitchbox playbook '${opts.slug}' for campaign ` +
        `${opts.env.PITCHBOX_CAMPAIGN_ID ?? ''}.\n\n${playbook}`;

      let tokensUsed: number | undefined;
      let lastUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        totalCostUsd?: number;
      } | null = null;
      let seq = 0;

      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = this.spawn(
          this.binary,
          [
            'run',
            '--json',
            ...(this.config.model ? ['--model', this.config.model] : []),
            ...(this.config.extraArgs ?? []),
            prompt,
          ],
          {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );

        cancelFn = () => {
          child.kill('SIGTERM');
          const t = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // already gone
            }
          }, 5000);
          child.once('exit', () => clearTimeout(t));
        };

        writeFileSync(logPath, `# run ${opts.slug} started ${new Date().toISOString()}\n`, 'utf8');
        let buffer = '';

        const emitLine = (line: string) => {
          if (!line) return;
          appendFileSync(logPath, line + '\n', 'utf8');
          console.log(`[opencode ${opts.slug}] ${line.slice(0, 200)}`);
          opts.onRawLine?.(line);

          const events = parseOpenCodeLine(line, seq);
          seq += events.length > 0 ? events.length : 1;

          for (const e of events) {
            if (e.kind === 'result' && e.payload?.type === 'result') {
              const r = e.payload;
              tokensUsed = (r.inputTokens ?? 0) + (r.outputTokens ?? 0) || tokensUsed;
              if (
                r.inputTokens != null ||
                r.outputTokens != null ||
                r.cacheReadTokens != null ||
                r.cacheCreationTokens != null ||
                r.totalCostUsd != null
              ) {
                lastUsage = {
                  inputTokens: r.inputTokens ?? 0,
                  outputTokens: r.outputTokens ?? 0,
                  cacheReadTokens: r.cacheReadTokens ?? 0,
                  cacheCreationTokens: r.cacheCreationTokens ?? 0,
                  totalCostUsd: r.totalCostUsd,
                };
              }
            }
          }

          if (events.length > 0) void opts.onParsedEvents?.(events);
        };

        child.stdout?.on('data', (d: Buffer) => {
          buffer += d.toString('utf8');
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

      const lu = lastUsage as {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        totalCostUsd?: number;
      } | null;
      const usage = lu
        ? {
            inputTokens: lu.inputTokens,
            outputTokens: lu.outputTokens,
            cacheReadTokens: lu.cacheReadTokens,
            cacheCreationTokens: lu.cacheCreationTokens,
            costUsd:
              typeof lu.totalCostUsd === 'number'
                ? Number(lu.totalCostUsd.toFixed(4))
                : computeCostUsd(lu),
            costReported: typeof lu.totalCostUsd === 'number',
          }
        : undefined;
      return { exitCode, logPath, tokensUsed, usage };
    })();

    return { result, cancel: () => cancelFn() };
  }
}
