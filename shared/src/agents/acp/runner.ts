// shared/src/agents/acp/runner.ts
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunHandle, AgentRunOptions, AgentRunResult, AgentRunner } from '../base.js';
import type { RunnerConfig } from '../config.js';
import type { ParsedEvent } from '../../runlog/types.js';
import { computeCostUsd } from '../../runlog/usage.js';
import { ACP_BACKENDS, type AcpBackendSlug, type BackendSpec } from './backends.js';
import {
  normalizeAcpUpdate,
  normalizeStopReason,
  type AcpStopReasonKind,
  type AcpUsage,
} from './event-normalizer.js';
import {
  AutoAllowPolicy,
  selectPermissionOption,
  type PermissionOption,
  type PermissionPolicy,
} from './permission.js';

type SpawnFn = typeof nodeSpawn;

export interface AcpRunnerOptions {
  slug: AcpBackendSlug;
  config?: RunnerConfig;
  spawn?: SpawnFn;
  logDir?: string;
  policy?: PermissionPolicy;
  initializeTimeoutMs?: number;
}

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export class AcpRunner implements AgentRunner {
  readonly slug: AcpBackendSlug;
  private readonly spec: BackendSpec;
  private readonly spawn: SpawnFn;
  private readonly logDir: string;
  private readonly policy: PermissionPolicy;
  private readonly initializeTimeoutMs: number;
  // Placeholder for per-run config that future tasks will use.
  // eslint-disable-next-line @typescript-eslint/no-unused-private-class-members
  private readonly config: RunnerConfig;

  constructor(opts: AcpRunnerOptions) {
    this.slug = opts.slug;
    this.spec = ACP_BACKENDS[opts.slug];
    if (!this.spec) throw new Error(`Unknown ACP backend slug: ${opts.slug}`);
    this.spawn = opts.spawn ?? nodeSpawn;
    this.logDir = opts.logDir ?? join(process.cwd(), 'daemon', 'logs');
    this.policy = opts.policy ?? new AutoAllowPolicy();
    this.initializeTimeoutMs = opts.initializeTimeoutMs ?? 10_000;
    this.config = opts.config ?? {};
  }

  run(opts: AgentRunOptions): AgentRunHandle {
    let cancelFn: () => void = () => {};
    const policy = this.policy;

    const result: Promise<AgentRunResult> = (async () => {
      mkdirSync(this.logDir, { recursive: true });
      const logPath = join(this.logDir, `run-${Date.now()}-${opts.slug}.log`);
      writeFileSync(logPath, `# run ${opts.slug} started ${new Date().toISOString()}\n`, 'utf8');

      const playbook = await readFile(opts.playbookPath, 'utf8');
      const promptText = buildPrompt(opts, playbook);

      const envPass: Record<string, string | undefined> = {};
      for (const key of this.spec.envPassthrough ?? []) {
        envPass[key] = process.env[key];
      }

      const child = this.spawn(this.spec.binary, [...this.spec.acpArgs], {
        cwd: opts.cwd,
        env: { ...process.env, ...envPass, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;

      let sessionId: string | null = null;
      let nextId = 1;
      const pending = new Map<number, (msg: JsonRpcMessage) => void>();
      let seq = 0;
      let cancelRequested = false;
      let childExited = false;

      const writeMessage = (msg: JsonRpcMessage) => {
        const line = JSON.stringify(msg) + '\n';
        appendFileSync(logPath, `[->] ${line}`, 'utf8');
        child.stdin.write(line);
      };

      const sendNotification = (method: string, params: unknown) =>
        writeMessage({ jsonrpc: '2.0', method, params });

      const sendResponse = (id: number | string, result: unknown) =>
        writeMessage({ jsonrpc: '2.0', id, result });

      const sendRequest = <T = unknown>(method: string, params: unknown): Promise<T> => {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, (msg) => {
            if (msg.error) reject(new Error(`${method} failed: ${msg.error.message}`));
            else resolve(msg.result as T);
          });
          writeMessage({ jsonrpc: '2.0', id, method, params });
        });
      };

      cancelFn = () => {
        cancelRequested = true;
        if (sessionId) {
          try {
            sendNotification('session/cancel', { sessionId });
          } catch {
            // ignore; SIGTERM follows
          }
        }
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }, 5000);
        child.once('exit', () => clearTimeout(t));
      };

      // Buffers for streamed assistant/thinking text chunks. ACP emits one
      // `agent_message_chunk` per generated token/group, which would otherwise
      // produce a row per chunk in the runlog. We accumulate and flush as a
      // single ParsedEvent when a non-chunk update arrives (or at stop_reason).
      let pendingAssistantText = '';
      let pendingThinkingText = '';

      const flushPendingText = () => {
        const flushed: ParsedEvent[] = [];
        if (pendingAssistantText.length > 0) {
          flushed.push({
            seq,
            kind: 'assistant',
            payload: { type: 'assistant', text: pendingAssistantText },
            raw: '',
          });
          seq += 1;
          pendingAssistantText = '';
        }
        if (pendingThinkingText.length > 0) {
          flushed.push({
            seq,
            kind: 'thinking',
            payload: { type: 'thinking', text: pendingThinkingText },
            raw: '',
          });
          seq += 1;
          pendingThinkingText = '';
        }
        if (flushed.length > 0) void opts.onParsedEvents?.(flushed);
      };

      const extractChunkText = (update: unknown): string => {
        const u = update as { content?: unknown } | null;
        const c = (u?.content ?? null) as { text?: unknown } | null;
        return typeof c?.text === 'string' ? c.text : '';
      };

      const handleStdoutLine = (line: string) => {
        if (!line.trim()) return;
        appendFileSync(logPath, `[<-] ${line}\n`, 'utf8');
        opts.onRawLine?.(line);
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          return;
        }
        if (
          msg.id != null &&
          (msg.result !== undefined || msg.error !== undefined) &&
          !msg.method
        ) {
          const cb = pending.get(msg.id as number);
          if (cb) {
            pending.delete(msg.id as number);
            cb(msg);
          }
          return;
        }
        if (msg.method === 'session/update') {
          const params = msg.params as { sessionId?: string; update?: unknown } | undefined;
          const updateKind = (params?.update as { sessionUpdate?: string } | null)?.sessionUpdate;

          // Coalesce streamed text chunks into a single rendered event.
          if (updateKind === 'agent_message_chunk') {
            pendingAssistantText += extractChunkText(params?.update);
            return;
          }
          if (updateKind === 'agent_thought_chunk') {
            pendingThinkingText += extractChunkText(params?.update);
            return;
          }
          // ACP emits incremental usage_update events between tokens. The
          // total usage arrives with `stop_reason`, so the incremental
          // ones are noise for the runlog UI.
          if (updateKind === 'usage_update') {
            return;
          }

          // Any other kind: flush buffered text first, then normalize this event.
          flushPendingText();
          const produced = normalizeAcpUpdate(params?.update, line, seq);
          seq += Math.max(produced.length, 1);
          if (produced.length > 0) void opts.onParsedEvents?.(produced);
          return;
        }
        if (msg.method === 'session/request_permission' && msg.id != null) {
          const params = msg.params as
            | {
                toolCall?: { toolName?: string; args?: Record<string, unknown> };
                options?: PermissionOption[];
              }
            | undefined;
          const tc = params?.toolCall;
          const decision = policy.decide({
            toolName: tc?.toolName ?? 'unknown',
            args: tc?.args ?? {},
          });
          // ACP expects a selected optionId, not a bare verdict. Map the decision
          // onto one of the offered options; if none matches, cancel rather than
          // send a shape the agent will reject.
          const selected = selectPermissionOption(params?.options ?? [], decision);
          sendResponse(
            msg.id,
            selected
              ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
              : { outcome: { outcome: 'cancelled' } },
          );
          return;
        }
      };

      let stdoutBuf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) handleStdoutLine(line);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        appendFileSync(logPath, `[stderr] ${chunk}`, 'utf8');
        opts.onRawLine?.(`[stderr] ${chunk.trimEnd()}`);
      });

      const runTimer = setTimeout(() => cancelFn(), opts.timeoutMs);

      const exitCodePromise = new Promise<number>((resolve, reject) => {
        child.on('exit', (code) => {
          clearTimeout(runTimer);
          appendFileSync(logPath, `\n# exit ${code} at ${new Date().toISOString()}\n`, 'utf8');
          childExited = true;
          // Reject any in-flight JSON-RPC requests so the run finishes instead
          // of hanging on a request that will never be answered (e.g. after
          // cancel() or an unexpected child crash).
          if (pending.size > 0) {
            const entries = Array.from(pending.entries());
            pending.clear();
            const reason = cancelRequested ? 'cancelled' : `child exited with code ${code ?? 1}`;
            for (const [, cb] of entries) {
              cb({
                jsonrpc: '2.0',
                error: { code: -32000, message: reason },
              });
            }
          }
          resolve(code ?? 1);
        });
        child.on('error', (err) => {
          clearTimeout(runTimer);
          reject(err);
        });
      });

      // 1. initialize
      const initPromise = sendRequest<{ protocolVersion?: number }>('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      });
      const initTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ACP initialize timed out')), this.initializeTimeoutMs),
      );
      await Promise.race([initPromise, initTimeoutPromise]);

      // 2. session/new
      const sessionResult = await sendRequest<{ sessionId: string }>('session/new', {
        cwd: opts.cwd,
        mcpServers: [buildPitchboxMcpServer(opts)],
      });
      sessionId = sessionResult.sessionId;

      // 3. session/prompt
      let promptResult: { stopReason?: string; usage?: AcpUsage };
      try {
        promptResult = await sendRequest<{ stopReason?: string; usage?: AcpUsage }>(
          'session/prompt',
          { sessionId, prompt: [{ type: 'text', text: promptText }] },
        );
      } catch (err) {
        // If the child exited mid-prompt (cancel or crash), synthesize an
        // appropriate stop reason instead of bubbling the rejection.
        if (cancelRequested || childExited) {
          promptResult = { stopReason: cancelRequested ? 'cancelled' : 'error' };
        } else {
          throw err;
        }
      }
      const stopReason: AcpStopReasonKind | string = promptResult.stopReason ?? 'end_turn';
      const stopUsage = promptResult.usage;

      // Flush any tail-end assistant/thinking text the agent emitted right
      // before the stop_reason. Without this, the final tokens of the last
      // message would be silently dropped.
      flushPendingText();

      // Synthesize a final result event so the runlog has a closing record.
      const tail = normalizeStopReason(stopReason, stopUsage, '', seq);
      seq += tail.length;
      if (tail.length > 0) void opts.onParsedEvents?.(tail);

      // 4. close child cleanly
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      const exitCode = await exitCodePromise;

      const usage = buildUsage(stopUsage);
      const tokensUsed = usage ? usage.inputTokens + usage.outputTokens : undefined;

      return { exitCode, logPath, tokensUsed, usage };
    })();

    return { result, cancel: () => cancelFn() };
  }
}

function buildPrompt(opts: AgentRunOptions, playbook: string): string {
  const campaign = opts.env.PITCHBOX_CAMPAIGN_ID ?? '';
  return `You are running the Pitchbox playbook '${opts.slug}' for campaign ${campaign}.\n\n${playbook}`;
}

/**
 * Build the ACP `mcpServers` entry for the Pitchbox MCP server. Every run hands
 * the agent this stdio server so it can reach Pitchbox data through MCP tools
 * (the data-access boundary shared with the cloud runner; see
 * docs/cloud-runner.md). It is spawned from the repo's `bin/pitchbox-mcp`
 * wrapper and reads its DB config from the forwarded env (or the repo `.env`).
 */
function buildPitchboxMcpServer(opts: AgentRunOptions): {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
} {
  const root = opts.env.PITCHBOX_ROOT || opts.cwd;
  const merged: Record<string, string | undefined> = { ...process.env, ...opts.env };
  const env: { name: string; value: string }[] = [];
  for (const key of ['DATABASE_URL', 'PITCHBOX_ROOT', 'ENCRYPTION_KEY', 'PATH', 'NODE_ENV']) {
    const value = merged[key];
    if (typeof value === 'string' && value.length > 0) env.push({ name: key, value });
  }
  return { name: 'pitchbox', command: join(root, 'bin', 'pitchbox-mcp'), args: [], env };
}

function buildUsage(u: AcpUsage | undefined) {
  if (!u) return undefined;
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  const cacheReadTokens = u.cacheReadTokens ?? 0;
  const cacheCreationTokens = u.cacheCreationTokens ?? 0;
  const reported = typeof u.totalCostUsd === 'number';
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd: reported
      ? Number((u.totalCostUsd as number).toFixed(4))
      : computeCostUsd({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }),
    costReported: reported,
  };
}
