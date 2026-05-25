// shared/tests/agents/acp/runner.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from 'node:child_process';
import { AcpRunner } from '../../../src/agents/acp/runner.js';
import { MockAcpServer, type MockHandlers } from './mock-acp-server.js';
import type { ParsedEvent } from '../../../src/runlog/types.js';

// Build a fake child process that behaves enough like ChildProcessWithoutNullStreams
// for the runner to operate against. It owns two PassThrough streams (stdin = what
// the runner writes; stdout = what the runner reads), an EventEmitter for lifecycle
// signals, and a kill() that triggers an 'exit' event.
function makeFakeChild(): {
  child: ChildProcessWithoutNullStreams;
  stdin: PassThrough;
  stdout: PassThrough;
  emitExit: (code: number) => void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  let exited = false;
  const emitExit = (code: number) => {
    if (exited) return;
    exited = true;
    queueMicrotask(() => emitter.emit('exit', code));
  };
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      emitExit(0);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, stdin, stdout, emitExit };
}

function makeRunner(handlers: MockHandlers = {}) {
  const { child, stdin, stdout, emitExit } = makeFakeChild();
  // From the runner's POV: it writes to child.stdin and reads from child.stdout.
  // The mock server's POV is the opposite: it reads from child.stdin (what the
  // runner produced) and writes to child.stdout (what the runner will read).
  const server = new MockAcpServer(stdin, stdout, handlers);
  const fakeSpawn = (() => child) as unknown as typeof nodeSpawn;
  // When the runner ends stdin (after session/prompt resolves), surface that as
  // a child 'exit' so the run finishes cleanly. The cancel() path emits exit
  // directly via the fake child's kill().
  stdin.on('end', () => emitExit(0));
  const runner = new AcpRunner({
    slug: 'claude-code',
    spawn: fakeSpawn,
    initializeTimeoutMs: 1000,
    logDir: mkdtempSync(join(tmpdir(), 'acp-test-log-')),
  });
  return { runner, server, emitExit };
}

function tmpPlaybook(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-playbook-'));
  const p = join(dir, 'playbook.md');
  writeFileSync(p, 'This is a test playbook.\n', 'utf8');
  return p;
}

describe('AcpRunner integration', () => {
  let playbookPath: string;
  beforeEach(() => {
    playbookPath = tmpPlaybook();
  });

  it('happy path: drives initialize -> session/new -> prompt -> stop_reason', async () => {
    const events: ParsedEvent[] = [];
    const { runner, server } = makeRunner({
      onSessionPrompt: async () => {
        // Push an agent message before resolving the prompt.
        server.sendUpdate('sess-mock-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from agent' },
        });
        // Tiny delay to let the runner process the update before we resolve.
        await new Promise((r) => setTimeout(r, 10));
        return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });
    const handle = runner.run({
      playbookPath,
      slug: 'reddit-scout',
      env: { PITCHBOX_CAMPAIGN_ID: 'c1' },
      cwd: process.cwd(),
      timeoutMs: 5000,
      onParsedEvents: (evs) => {
        for (const e of evs) events.push(e);
      },
    });
    const res = await handle.result;
    expect(res.exitCode).toBe(0);
    expect(res.usage?.inputTokens).toBe(10);
    expect(res.usage?.outputTokens).toBe(5);
    expect(
      events.some(
        (e) =>
          e.kind === 'assistant' &&
          (e.payload as { text: string }).text === 'Hello from agent',
      ),
    ).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(true);
  });

  it('auto-allows session/request_permission via default policy', async () => {
    let ack: unknown = null;
    const { runner, server } = makeRunner({
      onSessionPrompt: async () => {
        ack = await server.requestPermission('sess-mock-1', 'bash', { cmd: 'ls' });
        return { stopReason: 'end_turn' };
      },
    });
    const handle = runner.run({
      playbookPath,
      slug: 'x',
      env: {},
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    await handle.result;
    expect(ack).toMatchObject({ outcome: { type: 'allow' } });
  });

  it('treats stop_reason: error as success=false', async () => {
    const events: ParsedEvent[] = [];
    const { runner } = makeRunner({
      onSessionPrompt: () => ({ stopReason: 'error' }),
    });
    const handle = runner.run({
      playbookPath,
      slug: 'x',
      env: {},
      cwd: process.cwd(),
      timeoutMs: 5000,
      onParsedEvents: (evs) => {
        for (const e of evs) events.push(e);
      },
    });
    await handle.result;
    const final = events.find((e) => e.kind === 'result');
    expect(final).toBeDefined();
    expect((final!.payload as { success: boolean }).success).toBe(false);
  });

  it('cancel() sends session/cancel + SIGTERM', async () => {
    let cancelSeen = false;
    const { runner } = makeRunner({
      onSessionCancel: () => {
        cancelSeen = true;
        return null;
      },
      onSessionPrompt: () =>
        new Promise(() => {
          /* never resolves */
        }),
    });
    const handle = runner.run({
      playbookPath,
      slug: 'x',
      env: {},
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });
    setTimeout(() => handle.cancel(), 50);
    const res = await handle.result;
    expect(res.exitCode).toBe(0);
    // Give the mock server a tick to observe the buffered session/cancel notification.
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelSeen).toBe(true);
  });

  it('initialize timeout rejects fast', async () => {
    const { runner } = makeRunner({
      onInitialize: () =>
        new Promise(() => {
          /* never responds */
        }),
    });
    const handle = runner.run({
      playbookPath,
      slug: 'x',
      env: {},
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });
    await expect(handle.result).rejects.toThrow(/initialize/i);
  });
});
