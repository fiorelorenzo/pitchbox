import { describe, it, expect } from 'vitest';
import {
  normalizeAcpUpdate,
  normalizeStopReason,
} from '../../../src/agents/acp/event-normalizer.js';

const raw = '<<test-raw-line>>';

describe('normalizeAcpUpdate', () => {
  it('maps agent_message_chunk to assistant event', () => {
    const events = normalizeAcpUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
      raw,
      0,
    );
    expect(events).toEqual([
      { seq: 0, kind: 'assistant', payload: { type: 'assistant', text: 'Hello' }, raw },
    ]);
  });

  it('maps agent_thought_chunk to thinking event', () => {
    const events = normalizeAcpUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } },
      raw,
      0,
    );
    expect(events).toEqual([
      { seq: 0, kind: 'thinking', payload: { type: 'thinking', text: 'thinking...' }, raw },
    ]);
  });

  it('maps tool_call to tool-call event', () => {
    const events = normalizeAcpUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Run pitchbox drafts:create',
        kind: 'execute',
        rawInput: { command: 'pitchbox drafts:create' },
      },
      raw,
      0,
    );
    expect(events).toEqual([
      {
        seq: 0,
        kind: 'tool-call',
        payload: {
          type: 'tool-call',
          id: 't1',
          name: 'Bash',
          input: { command: 'pitchbox drafts:create' },
        },
        raw,
      },
    ]);
  });

  it('suppresses placeholder tool_call with empty rawInput', () => {
    const events = normalizeAcpUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Terminal',
        kind: 'execute',
        rawInput: {},
      },
      raw,
      0,
    );
    expect(events).toEqual([]);
  });

  it('synthesizes a tool-call from tool_call_update when rawInput is filled in', () => {
    const events = normalizeAcpUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'ls -la /tmp',
        kind: 'execute',
        rawInput: { command: 'ls -la /tmp', description: 'List tmp' },
      },
      raw,
      5,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 5,
      kind: 'tool-call',
      payload: { type: 'tool-call', id: 't1', name: 'Bash', input: { command: 'ls -la /tmp' } },
    });
  });

  it('maps tool_call_update with completed content to tool-result', () => {
    const events = normalizeAcpUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '{"ok":true}' } }],
      },
      raw,
      0,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 0,
      kind: 'tool-result',
      payload: {
        type: 'tool-result',
        toolUseId: 't1',
        isError: false,
        text: '{"ok":true}',
      },
    });
  });

  it('marks tool_call_update with status failed as error', () => {
    const events = normalizeAcpUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
      },
      raw,
      0,
    );
    expect(events[0].payload).toMatchObject({ isError: true, text: 'boom' });
  });

  it('drops unknown sessionUpdate kinds with an unknown event', () => {
    const events = normalizeAcpUpdate({ sessionUpdate: 'made_up_kind', whatever: 1 }, raw, 0);
    expect(events).toEqual([
      {
        seq: 0,
        kind: 'unknown',
        payload: { type: 'unknown', eventType: 'made_up_kind', raw },
        raw,
      },
    ]);
  });

  it('tolerates malformed updates without throwing', () => {
    expect(() => normalizeAcpUpdate({}, raw, 0)).not.toThrow();
    expect(() => normalizeAcpUpdate(null, raw, 0)).not.toThrow();
    expect(() => normalizeAcpUpdate('not-an-object', raw, 0)).not.toThrow();
  });
});

describe('normalizeStopReason', () => {
  it('builds a result event with usage when reported', () => {
    const events = normalizeStopReason(
      'end_turn',
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        totalCostUsd: 0.0123,
      },
      raw,
      42,
    );
    expect(events).toEqual([
      {
        seq: 42,
        kind: 'result',
        payload: {
          type: 'result',
          success: true,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
          totalCostUsd: 0.0123,
        },
        raw,
      },
    ]);
  });

  it('marks cancelled and error stop reasons as not success', () => {
    const cancelled = normalizeStopReason('cancelled', undefined, raw, 0);
    expect(cancelled[0].payload).toMatchObject({ type: 'result', success: false });
    const errored = normalizeStopReason('error', undefined, raw, 0);
    expect(errored[0].payload).toMatchObject({ type: 'result', success: false });
  });
});
