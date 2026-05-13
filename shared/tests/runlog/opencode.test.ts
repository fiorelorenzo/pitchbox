import { describe, it, expect } from 'vitest';
import { parseOpenCodeLine } from '../../src/runlog/parsers/opencode.js';

describe('parseOpenCodeLine', () => {
  it('parses session.start into a session event', () => {
    const line = JSON.stringify({
      type: 'session.start',
      session_id: 's-1',
      model: 'opencode-default',
    });
    const events = parseOpenCodeLine(line, 0);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('session');
    expect(events[0].payload).toMatchObject({
      type: 'session',
      sessionId: 's-1',
      model: 'opencode-default',
    });
  });

  it('parses message.end with assistant role into an assistant event', () => {
    const line = JSON.stringify({
      type: 'message.end',
      role: 'assistant',
      content: 'hello world',
    });
    const events = parseOpenCodeLine(line, 5);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('assistant');
    expect(events[0].seq).toBe(5);
    expect(events[0].payload).toMatchObject({ type: 'assistant', text: 'hello world' });
  });

  it('parses tool.start and tool.end as tool-call/tool-result pair', () => {
    const start = parseOpenCodeLine(
      JSON.stringify({
        type: 'tool.start',
        tool: 'bash',
        input: { cmd: 'ls' },
        id: 't-1',
      }),
      0,
    );
    const end = parseOpenCodeLine(
      JSON.stringify({
        type: 'tool.end',
        tool: 'bash',
        output: 'file.txt\n',
        is_error: false,
        id: 't-1',
      }),
      1,
    );
    expect(start).toHaveLength(1);
    expect(start[0].kind).toBe('tool-call');
    expect(start[0].payload).toMatchObject({
      type: 'tool-call',
      name: 'bash',
      input: { cmd: 'ls' },
      id: 't-1',
    });
    expect(end).toHaveLength(1);
    expect(end[0].kind).toBe('tool-result');
    expect(end[0].payload).toMatchObject({
      type: 'tool-result',
      text: 'file.txt\n',
      isError: false,
      toolUseId: 't-1',
    });
  });

  it('parses session.end with usage + cost_usd into a result event', () => {
    const line = JSON.stringify({
      type: 'session.end',
      usage: { input_tokens: 100, output_tokens: 50 },
      cost_usd: 1.23,
    });
    const events = parseOpenCodeLine(line, 0);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('result');
    expect(events[0].payload).toMatchObject({
      type: 'result',
      success: true,
      inputTokens: 100,
      outputTokens: 50,
      totalCostUsd: 1.23,
    });
  });

  it('returns an unknown event for unrecognised types and skips blank lines', () => {
    expect(parseOpenCodeLine('', 0)).toEqual([]);
    expect(parseOpenCodeLine('   ', 0)).toEqual([]);
    expect(parseOpenCodeLine('not json', 0)).toEqual([]);
    const events = parseOpenCodeLine(JSON.stringify({ type: 'mystery', foo: 1 }), 7);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('unknown');
    expect(events[0].seq).toBe(7);
  });
});
