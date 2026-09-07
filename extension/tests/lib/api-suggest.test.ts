import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseSuggestSseFrame, type SuggestEvent } from '../../src/lib/api.js';

// Minimal chrome.storage.local mock so api.ts's getSettings()/patchPairing() resolve,
// matching api-fanout.test.ts's own setup.
(globalThis as any).chrome = {
  storage: {
    local: {
      _s: {} as Record<string, unknown>,
      async get(keys: string[] | string) {
        const k = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const x of k) if (x in this._s) out[x] = this._s[x];
        return out;
      },
      async set(patch: Record<string, unknown>) {
        Object.assign(this._s, patch);
      },
      async remove(keys: string[] | string) {
        const k = Array.isArray(keys) ? keys : [keys];
        for (const x of k) delete this._s[x];
      },
    },
  },
};

const BACKEND = 'https://backend.example';

function seed() {
  (globalThis as any).chrome.storage.local._s = {
    pairings: [{ backendUrl: BACKEND, token: 't'.repeat(40) }],
  };
}

beforeEach(() => {
  (globalThis as any).chrome.storage.local._s = {};
  vi.restoreAllMocks();
});

describe('parseSuggestSseFrame', () => {
  it('parses a status frame', () => {
    expect(parseSuggestSseFrame('event: status\ndata: {"phase":"reading"}')).toEqual({
      kind: 'status',
      phase: 'reading',
    });
  });

  it('parses a chunk frame, carrying which section it belongs to', () => {
    expect(
      parseSuggestSseFrame('event: chunk\ndata: {"text":"Great post","section":"draft"}'),
    ).toEqual({
      kind: 'chunk',
      text: 'Great post',
      section: 'draft',
    });
  });

  it('returns null for a chunk with no recognised section', () => {
    expect(
      parseSuggestSseFrame('event: chunk\ndata: {"text":"Great post","section":"nonsense"}'),
    ).toBeNull();
  });

  it('parses a done frame with usage, reasoning and a draft', () => {
    expect(
      parseSuggestSseFrame(
        'event: done\ndata: {"reasoning":"Sounds upbeat.","draft":"Great post!","skipped":false,"usage":{"outputTokens":12},"ms":2200}',
      ),
    ).toEqual({
      kind: 'done',
      reasoning: 'Sounds upbeat.',
      draft: 'Great post!',
      skipped: false,
      usage: { outputTokens: 12 },
      ms: 2200,
    });
  });

  it('parses a done frame with no draft - the marker never arrived (#382)', () => {
    expect(
      parseSuggestSseFrame(
        'event: done\ndata: {"reasoning":"Nothing worth adding here.","draft":null,"skipped":true,"ms":900}',
      ),
    ).toEqual({
      kind: 'done',
      reasoning: 'Nothing worth adding here.',
      draft: null,
      skipped: true,
      usage: undefined,
      ms: 900,
    });
  });

  it('parses a failed frame', () => {
    expect(parseSuggestSseFrame('event: failed\ndata: {"message":"agent crashed"}')).toEqual({
      kind: 'failed',
      message: 'agent crashed',
    });
  });

  it('returns null for the leading padding comment line', () => {
    expect(parseSuggestSseFrame(`: ${' '.repeat(2048)}`)).toBeNull();
  });

  it('returns null for an unrecognised event kind, rather than throwing', () => {
    expect(parseSuggestSseFrame('event: mystery\ndata: {"whatever":1}')).toBeNull();
  });

  it('returns null for malformed JSON, rather than throwing', () => {
    expect(parseSuggestSseFrame('event: chunk\ndata: {not json')).toBeNull();
  });
});

function sseStream(frames: string[], chunkBoundaryInsideFrame = false): ReadableStream {
  const encoder = new TextEncoder();
  const full = frames.map((f) => `${f}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      if (chunkBoundaryInsideFrame) {
        // Split arbitrarily in the middle of the encoded bytes, proving the
        // frame parser reassembles a frame split across two reader.read() calls.
        const bytes = encoder.encode(full);
        const mid = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
      } else {
        controller.enqueue(encoder.encode(full));
      }
      controller.close();
    },
  });
}

describe('api.suggest', () => {
  it('streams status, chunk, and done events in order as they arrive', async () => {
    seed();
    const { api } = await import('../../src/lib/api.js');
    const frames = [
      'event: status\ndata: {"phase":"reading"}',
      'event: status\ndata: {"phase":"writing"}',
      'event: chunk\ndata: {"text":"Great ","section":"draft"}',
      'event: chunk\ndata: {"text":"post!","section":"draft"}',
      'event: done\ndata: {"reasoning":"Positive tone.","draft":"Great post!","skipped":false,"ms":2200}',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(sseStream(frames), { headers: { 'content-type': 'text/event-stream' } }),
      ),
    );

    const events: SuggestEvent[] = [];
    const res = await api.suggest(
      { projectId: 1, kind: 'post_comment', post: { text: 'a post' } },
      (e) => events.push(e),
    );

    expect(res.ok).toBe(true);
    expect(events).toEqual([
      { kind: 'status', phase: 'reading' },
      { kind: 'status', phase: 'writing' },
      { kind: 'chunk', text: 'Great ', section: 'draft' },
      { kind: 'chunk', text: 'post!', section: 'draft' },
      {
        kind: 'done',
        reasoning: 'Positive tone.',
        draft: 'Great post!',
        skipped: false,
        usage: undefined,
        ms: 2200,
      },
    ]);
  });

  it('reassembles a frame split across two reader chunks', async () => {
    seed();
    const { api } = await import('../../src/lib/api.js');
    const frames = [
      'event: chunk\ndata: {"text":"a fairly long chunk of streamed text here","section":"draft"}',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(sseStream(frames, true), {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );

    const events: SuggestEvent[] = [];
    await api.suggest({ projectId: 1, kind: 'post_comment', post: { text: 'a post' } }, (e) =>
      events.push(e),
    );

    expect(events).toEqual([
      { kind: 'chunk', text: 'a fairly long chunk of streamed text here', section: 'draft' },
    ]);
  });

  it('maps a pre-stream JSON refusal to a refused event, not an error result', async () => {
    seed();
    const { api } = await import('../../src/lib/api.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              refused: 'quota_exhausted',
              kind: 'comment',
              window: 'day',
              limit: 8,
              used: 8,
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          ),
      ),
    );

    const events: SuggestEvent[] = [];
    const res = await api.suggest(
      { projectId: 1, kind: 'post_comment', post: { text: 'a post' } },
      (e) => events.push(e),
    );

    expect(res.ok).toBe(true);
    expect(events).toEqual([
      {
        kind: 'refused',
        reason: 'quota_exhausted',
        detail: { kind: 'comment', window: 'day', limit: 8, used: 8 },
      },
    ]);
  });

  it('reports a non-2xx status as a transport failure, without calling onEvent', async () => {
    seed();
    const { api } = await import('../../src/lib/api.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('too many requests', { status: 429 })),
    );

    const onEvent = vi.fn();
    const res = await api.suggest(
      { projectId: 1, kind: 'post_comment', post: { text: 'a post' } },
      onEvent,
    );

    expect(res.ok).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe('api.acceptSuggestion', () => {
  it('returns the created draft and run id on success', async () => {
    seed();
    const { api } = await import('../../src/lib/api.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, draftId: 42, runId: 7 }), { status: 200 }),
      ),
    );

    const res = await api.acceptSuggestion({
      projectId: 1,
      kind: 'post_comment',
      post: { authorHandle: 'jane' },
      body: 'edited text',
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ accepted: true, draftId: 42, runId: 7 });
  });

  it('surfaces a refusal distinctly from a transport error', async () => {
    seed();
    const { api } = await import('../../src/lib/api.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ refused: 'no_account' }), { status: 200 })),
    );

    const res = await api.acceptSuggestion({
      projectId: 1,
      kind: 'post_comment',
      post: {},
      body: 'edited text',
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ accepted: false, refused: 'no_account', detail: {} });
  });
});
