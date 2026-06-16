// shared/tests/agents/acp/mock-acp-server.ts
import type { Readable, Writable } from 'node:stream';

type JsonRpcRequest = { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown };
type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};
type JsonRpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown };

export interface MockHandlers {
  onInitialize?: (params: unknown) => unknown;
  onSessionNew?: (params: unknown) => unknown;
  onSessionPrompt?: (params: unknown) => unknown;
  onSessionCancel?: (params: unknown) => unknown;
}

export class MockAcpServer {
  private buffer = '';
  private sessionPromptResolvers: Array<(p: unknown) => void> = [];
  private permissionAckResolvers: Array<(decision: unknown) => void> = [];
  private nextRequestId = 1000;

  constructor(
    private readonly stdin: Readable,
    private readonly stdout: Writable,
    private readonly handlers: MockHandlers = {},
  ) {
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcRequest | JsonRpcResponse;
        void this.dispatch(msg);
      } catch {
        // ignore
      }
    }
  }

  private async dispatch(msg: JsonRpcRequest | JsonRpcResponse) {
    if ('method' in msg) {
      const req = msg;
      let result: unknown;
      switch (req.method) {
        case 'initialize':
          result = (await this.handlers.onInitialize?.(req.params)) ?? {
            protocolVersion: 1,
            agentCapabilities: { tools: [] },
          };
          break;
        case 'session/new':
          result = (await this.handlers.onSessionNew?.(req.params)) ?? { sessionId: 'sess-mock-1' };
          break;
        case 'session/prompt':
          for (const r of this.sessionPromptResolvers) r(req.params);
          this.sessionPromptResolvers = [];
          result = (await this.handlers.onSessionPrompt?.(req.params)) ?? {
            stopReason: 'end_turn',
          };
          break;
        case 'session/cancel':
          result = (await this.handlers.onSessionCancel?.(req.params)) ?? null;
          break;
        default:
          result = null;
      }
      this.send({ jsonrpc: '2.0', id: req.id, result });
    } else {
      // Response to a server-originated request (e.g. session/request_permission).
      for (const r of this.permissionAckResolvers) r((msg as JsonRpcResponse).result);
      this.permissionAckResolvers = [];
    }
  }

  send(msg: JsonRpcResponse | JsonRpcNotification) {
    this.stdout.write(JSON.stringify(msg) + '\n');
  }

  sendUpdate(sessionId: string, update: unknown) {
    this.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  }

  waitForSessionPrompt(): Promise<unknown> {
    return new Promise((resolve) => this.sessionPromptResolvers.push(resolve));
  }

  requestPermission(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      this.permissionAckResolvers.push(resolve);
      this.send({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolName, args },
          // Mirror the option set the real adapter offers for a tool permission.
          options: [
            { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        },
      } as unknown as JsonRpcResponse);
    });
  }
}
