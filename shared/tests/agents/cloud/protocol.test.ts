import { describe, it, expect } from 'vitest';
import {
  CLOUD_PROTOCOL_VERSION,
  isSupportedProtocolVersion,
  isClientToRunner,
  isRunnerToClient,
  validateClientToRunner,
  validateRunnerToClient,
  type ClientToRunner,
  type RunnerToClient,
} from '../../../src/agents/cloud/protocol.js';

/** Shallow-copies `obj` and drops `key`, for constructing "field missing" fixtures. */
function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

const validSessionStart: ClientToRunner = {
  t: 'session.start',
  sessionId: 'sess-1',
  backend: 'claude-code',
  playbook: '# playbook body',
  slug: 'reddit-scout',
  context: { campaignId: 1, runId: 2, projectId: 3, env: { FOO: 'bar' } },
  timeoutMs: 900_000,
  version: CLOUD_PROTOCOL_VERSION,
};

const validClientMcp: ClientToRunner = {
  t: 'mcp',
  sessionId: 'sess-1',
  frame: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
};

const validSessionCancel: ClientToRunner = { t: 'session.cancel', sessionId: 'sess-1' };

const validSessionReady: RunnerToClient = { t: 'session.ready', sessionId: 'sess-1' };

const validSessionEvent: RunnerToClient = {
  t: 'session.event',
  sessionId: 'sess-1',
  update: { kind: 'agent_thought_chunk', text: 'thinking...' },
};

const validRunnerMcp: RunnerToClient = {
  t: 'mcp',
  sessionId: 'sess-1',
  frame: { jsonrpc: '2.0', id: 1, result: {} },
};

const validSessionDone: RunnerToClient = {
  t: 'session.done',
  sessionId: 'sess-1',
  stopReason: 'end_turn',
  usage: {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0.01,
  },
};

const validSessionDoneNoUsage: RunnerToClient = {
  t: 'session.done',
  sessionId: 'sess-1',
  stopReason: 'end_turn',
};

const validSessionError: RunnerToClient = {
  t: 'session.error',
  sessionId: 'sess-1',
  message: 'agent crashed',
};

describe('CLOUD_PROTOCOL_VERSION / isSupportedProtocolVersion', () => {
  it('accepts the current protocol version', () => {
    expect(isSupportedProtocolVersion(CLOUD_PROTOCOL_VERSION)).toBe(true);
  });

  it('rejects a newer or older version number', () => {
    expect(isSupportedProtocolVersion(CLOUD_PROTOCOL_VERSION + 1)).toBe(false);
    expect(isSupportedProtocolVersion(0)).toBe(false);
  });

  it('rejects non-numeric or missing values', () => {
    expect(isSupportedProtocolVersion(String(CLOUD_PROTOCOL_VERSION))).toBe(false);
    expect(isSupportedProtocolVersion(undefined)).toBe(false);
    expect(isSupportedProtocolVersion(null)).toBe(false);
  });
});

describe('validateClientToRunner: malformed envelopes', () => {
  it('rejects a non-object payload', () => {
    expect(validateClientToRunner('nope')).toEqual({
      valid: false,
      reason: 'not an object with a string "t" field',
    });
  });

  it('rejects null', () => {
    expect(validateClientToRunner(null)).toEqual({
      valid: false,
      reason: 'not an object with a string "t" field',
    });
  });

  it('rejects an array', () => {
    expect(validateClientToRunner([])).toEqual({
      valid: false,
      reason: 'not an object with a string "t" field',
    });
  });

  it('rejects an object with no "t" field', () => {
    expect(validateClientToRunner({ sessionId: 'x' })).toEqual({
      valid: false,
      reason: 'not an object with a string "t" field',
    });
  });

  it('rejects an object whose "t" field is not a string', () => {
    expect(validateClientToRunner({ t: 7 })).toEqual({
      valid: false,
      reason: 'not an object with a string "t" field',
    });
  });

  it('rejects an unknown "t"', () => {
    expect(validateClientToRunner({ t: 'session.explode', sessionId: 'x' })).toEqual({
      valid: false,
      reason: 'unknown message type "session.explode"',
    });
  });
});

describe('validateClientToRunner: session.start', () => {
  it('accepts a valid frame', () => {
    expect(validateClientToRunner(validSessionStart)).toEqual({
      valid: true,
      value: validSessionStart,
    });
  });

  it.each([
    [
      'missing sessionId',
      { ...validSessionStart, sessionId: undefined },
      'session.start: missing sessionId',
    ],
    [
      'wrong-type sessionId',
      { ...validSessionStart, sessionId: 42 },
      'session.start: missing sessionId',
    ],
    [
      'missing backend',
      { ...validSessionStart, backend: undefined },
      'session.start: missing backend',
    ],
    [
      'wrong-type backend',
      { ...validSessionStart, backend: null },
      'session.start: missing backend',
    ],
    [
      'missing playbook',
      { ...validSessionStart, playbook: undefined },
      'session.start: missing playbook',
    ],
    ['missing slug', { ...validSessionStart, slug: undefined }, 'session.start: missing slug'],
    [
      'context missing entirely',
      { ...validSessionStart, context: undefined },
      'session.start: invalid context',
    ],
    [
      'context not an object',
      { ...validSessionStart, context: 'nope' },
      'session.start: invalid context',
    ],
    [
      'context.env with a non-string value',
      { ...validSessionStart, context: { env: { FOO: 1 } } },
      'session.start: invalid context',
    ],
    [
      'context.campaignId not a finite number',
      { ...validSessionStart, context: { campaignId: Number.POSITIVE_INFINITY } },
      'session.start: invalid context',
    ],
    [
      'missing timeoutMs',
      { ...validSessionStart, timeoutMs: undefined },
      'session.start: invalid timeoutMs',
    ],
    [
      'wrong-type timeoutMs',
      { ...validSessionStart, timeoutMs: '900000' },
      'session.start: invalid timeoutMs',
    ],
  ] as const)('rejects %s', (_label, frame, expectedReason) => {
    expect(validateClientToRunner(frame)).toEqual({ valid: false, reason: expectedReason });
  });

  // The protocol version was hardened to be a required, numeric field (the
  // runner rejects a mismatch at handshake before spawning an agent). These
  // two cases are the ones that would silently pass again if that requirement
  // were reverted.
  it('rejects a frame with the version field omitted entirely', () => {
    expect(validateClientToRunner(omit(validSessionStart, 'version'))).toEqual({
      valid: false,
      reason: 'session.start: invalid version',
    });
  });

  it('rejects a frame whose version is a non-numeric value', () => {
    expect(validateClientToRunner({ ...validSessionStart, version: '1' })).toEqual({
      valid: false,
      reason: 'session.start: invalid version',
    });
  });
});

describe('validateClientToRunner: mcp', () => {
  it('accepts a valid frame', () => {
    expect(validateClientToRunner(validClientMcp)).toEqual({
      valid: true,
      value: validClientMcp,
    });
  });

  it('accepts a frame whose "frame" payload is present but falsy', () => {
    // The frame field is checked with `'frame' in m`, not truthiness, so an
    // explicit null/0/empty-string MCP payload must still be accepted - the
    // runner never inspects the frame contents, only tunnels it.
    expect(validateClientToRunner({ t: 'mcp', sessionId: 'sess-1', frame: null }).valid).toBe(true);
  });

  it('rejects a missing sessionId', () => {
    expect(validateClientToRunner(omit(validClientMcp, 'sessionId'))).toEqual({
      valid: false,
      reason: 'mcp: missing sessionId',
    });
  });

  it('rejects a missing frame key', () => {
    expect(validateClientToRunner(omit(validClientMcp, 'frame'))).toEqual({
      valid: false,
      reason: 'mcp: missing frame',
    });
  });
});

describe('validateClientToRunner: session.cancel', () => {
  it('accepts a valid frame', () => {
    expect(validateClientToRunner(validSessionCancel)).toEqual({
      valid: true,
      value: validSessionCancel,
    });
  });

  it('rejects a missing sessionId', () => {
    expect(validateClientToRunner({ t: 'session.cancel' })).toEqual({
      valid: false,
      reason: 'session.cancel: missing sessionId',
    });
  });
});

describe('validateRunnerToClient: malformed envelopes', () => {
  it('rejects a non-object payload', () => {
    expect(validateRunnerToClient('nope')).toEqual({
      valid: false,
      reason: 'not an object with a string "t" field',
    });
  });

  it('rejects null', () => {
    expect(validateRunnerToClient(null)).toEqual({
      valid: false,
      reason: 'not an object with a string "t" field',
    });
  });

  it('rejects an object with no "t" field', () => {
    expect(validateRunnerToClient({ sessionId: 'x' })).toEqual({
      valid: false,
      reason: 'not an object with a string "t" field',
    });
  });

  it('rejects an unknown "t"', () => {
    expect(validateRunnerToClient({ t: 'session.explode', sessionId: 'x' })).toEqual({
      valid: false,
      reason: 'unknown message type "session.explode"',
    });
  });
});

describe('validateRunnerToClient: session.ready', () => {
  it('accepts a valid frame', () => {
    expect(validateRunnerToClient(validSessionReady)).toEqual({
      valid: true,
      value: validSessionReady,
    });
  });

  it('rejects a missing sessionId', () => {
    expect(validateRunnerToClient({ t: 'session.ready' })).toEqual({
      valid: false,
      reason: 'session.ready: missing sessionId',
    });
  });
});

describe('validateRunnerToClient: session.event', () => {
  it('accepts a valid frame', () => {
    expect(validateRunnerToClient(validSessionEvent)).toEqual({
      valid: true,
      value: validSessionEvent,
    });
  });

  it('accepts an update payload that is present but falsy', () => {
    expect(
      validateRunnerToClient({ t: 'session.event', sessionId: 'sess-1', update: null }).valid,
    ).toBe(true);
  });

  it('rejects a missing sessionId', () => {
    expect(validateRunnerToClient(omit(validSessionEvent, 'sessionId'))).toEqual({
      valid: false,
      reason: 'session.event: missing sessionId',
    });
  });

  it('rejects a missing update key', () => {
    expect(validateRunnerToClient(omit(validSessionEvent, 'update'))).toEqual({
      valid: false,
      reason: 'session.event: missing update',
    });
  });
});

describe('validateRunnerToClient: mcp', () => {
  it('accepts a valid frame', () => {
    expect(validateRunnerToClient(validRunnerMcp)).toEqual({
      valid: true,
      value: validRunnerMcp,
    });
  });

  it('rejects a missing sessionId', () => {
    expect(validateRunnerToClient(omit(validRunnerMcp, 'sessionId'))).toEqual({
      valid: false,
      reason: 'mcp: missing sessionId',
    });
  });

  it('rejects a missing frame key', () => {
    expect(validateRunnerToClient(omit(validRunnerMcp, 'frame'))).toEqual({
      valid: false,
      reason: 'mcp: missing frame',
    });
  });
});

describe('validateRunnerToClient: session.done', () => {
  it('accepts a valid frame with usage', () => {
    expect(validateRunnerToClient(validSessionDone)).toEqual({
      valid: true,
      value: validSessionDone,
    });
  });

  it('accepts a valid frame without usage (usage is optional)', () => {
    expect(validateRunnerToClient(validSessionDoneNoUsage)).toEqual({
      valid: true,
      value: validSessionDoneNoUsage,
    });
  });

  it('rejects a missing sessionId', () => {
    expect(validateRunnerToClient(omit(validSessionDoneNoUsage, 'sessionId'))).toEqual({
      valid: false,
      reason: 'session.done: missing sessionId',
    });
  });

  it('rejects a missing stopReason', () => {
    expect(validateRunnerToClient(omit(validSessionDoneNoUsage, 'stopReason'))).toEqual({
      valid: false,
      reason: 'session.done: missing stopReason',
    });
  });

  it.each([
    ['not an object', 'lots of tokens'],
    ['a field with the wrong type', { inputTokens: '10' }],
  ] as const)('rejects usage that is %s', (_label, usage) => {
    expect(validateRunnerToClient({ ...validSessionDoneNoUsage, usage })).toEqual({
      valid: false,
      reason: 'session.done: invalid usage',
    });
  });
});

describe('validateRunnerToClient: session.error', () => {
  it('accepts a valid frame', () => {
    expect(validateRunnerToClient(validSessionError)).toEqual({
      valid: true,
      value: validSessionError,
    });
  });

  it('rejects a missing sessionId', () => {
    expect(validateRunnerToClient(omit(validSessionError, 'sessionId'))).toEqual({
      valid: false,
      reason: 'session.error: missing sessionId',
    });
  });

  it('rejects a missing message', () => {
    expect(validateRunnerToClient(omit(validSessionError, 'message'))).toEqual({
      valid: false,
      reason: 'session.error: missing message',
    });
  });
});

describe('isClientToRunner / isRunnerToClient agree with the validators', () => {
  const clientToRunnerFixtures: Array<[string, unknown]> = [
    ['valid session.start', validSessionStart],
    ['session.start missing version', omit(validSessionStart, 'version')],
    ['valid mcp', validClientMcp],
    ['mcp missing sessionId', omit(validClientMcp, 'sessionId')],
    ['valid session.cancel', validSessionCancel],
    ['unknown t', { t: 'session.explode' }],
    ['non-object', 'nope'],
    [
      'session.start with unsupported version',
      { ...validSessionStart, version: CLOUD_PROTOCOL_VERSION + 1 },
    ],
  ];

  it.each(clientToRunnerFixtures)(
    'isClientToRunner("%s") matches validateClientToRunner',
    (_label, frame) => {
      expect(isClientToRunner(frame)).toBe(validateClientToRunner(frame).valid);
    },
  );

  const runnerToClientFixtures: Array<[string, unknown]> = [
    ['valid session.ready', validSessionReady],
    ['session.ready missing sessionId', { t: 'session.ready' }],
    ['valid session.event', validSessionEvent],
    ['valid mcp', validRunnerMcp],
    ['valid session.done with usage', validSessionDone],
    ['valid session.done without usage', validSessionDoneNoUsage],
    ['session.done with invalid usage', { ...validSessionDoneNoUsage, usage: 'nope' }],
    ['valid session.error', validSessionError],
    ['unknown t', { t: 'session.explode' }],
    ['non-object', 42],
  ];

  it.each(runnerToClientFixtures)(
    'isRunnerToClient("%s") matches validateRunnerToClient',
    (_label, frame) => {
      expect(isRunnerToClient(frame)).toBe(validateRunnerToClient(frame).valid);
    },
  );

  it('isClientToRunner narrows unsupported-version frames as structurally valid (version support is a separate check)', () => {
    // isSupportedProtocolVersion is a distinct guard from the shape validators:
    // a frame can be a well-formed session.start (numeric version) yet speak an
    // unsupported protocol version. Callers must check both, which is exactly
    // what the runner's handshake does.
    const futureVersionFrame = { ...validSessionStart, version: CLOUD_PROTOCOL_VERSION + 1 };
    expect(isClientToRunner(futureVersionFrame)).toBe(true);
    expect(
      futureVersionFrame.t === 'session.start' &&
        isSupportedProtocolVersion(futureVersionFrame.version),
    ).toBe(false);
  });
});
