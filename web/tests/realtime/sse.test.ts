import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createSseManager, STALE_MS, RECONNECT_BASE_MS } from '../../src/lib/realtime/sse';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, Set<(e: Event) => void>>();
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(kind: string, fn: (e: Event) => void) {
    let s = this.listeners.get(kind);
    if (!s) {
      s = new Set();
      this.listeners.set(kind, s);
    }
    s.add(fn);
  }
  removeEventListener(kind: string, fn: (e: Event) => void) {
    this.listeners.get(kind)?.delete(fn);
  }
  close() {
    this.closed = true;
  }
  emit(kind: string, data: unknown = {}) {
    const evt = new MessageEvent(kind, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(kind) ?? []) fn(evt);
  }
  triggerError() {
    if (this.onerror) this.onerror(new Event('error'));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});

describe('createSseManager', () => {
  it('connects, fires status live on first event, and dispatches to subscribers', () => {
    const m = createSseManager({
      EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
    });
    const got: unknown[] = [];
    const states: string[] = [];
    m.subscribeStatus((s) => states.push(s));
    m.on('drafts:changed', (e) => got.push(JSON.parse(e.data)));

    expect(FakeEventSource.instances.length).toBe(1);
    FakeEventSource.instances[0].emit('drafts:changed', { ok: true });

    expect(got).toEqual([{ ok: true }]);
    expect(m.getStatus()).toBe('live');
    expect(states).toContain('live');
    m.close();
  });

  it('reconnects with backoff after staleness', () => {
    const m = createSseManager({
      EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
    });
    m.on('hello', () => {});
    const first = FakeEventSource.instances[0];
    first.emit('hello');
    expect(m.getStatus()).toBe('live');

    // Advance past staleness threshold — should drop and schedule reconnect.
    vi.advanceTimersByTime(STALE_MS + 1);
    expect(first.closed).toBe(true);
    expect(m.getStatus()).toBe('reconnecting');

    // After backoff base, a new source is created.
    vi.advanceTimersByTime(RECONNECT_BASE_MS + 1);
    expect(FakeEventSource.instances.length).toBe(2);
    m.close();
  });

  it('reconnects on EventSource error', () => {
    const m = createSseManager({
      EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
    });
    FakeEventSource.instances[0].triggerError();
    expect(m.getStatus()).toBe('reconnecting');
    m.close();
  });

  it('unsubscribe stops delivery for that handler', () => {
    const m = createSseManager({
      EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
    });
    let count = 0;
    const off = m.on('x', () => (count += 1));
    FakeEventSource.instances[0].emit('x');
    expect(count).toBe(1);
    off();
    FakeEventSource.instances[0].emit('x');
    expect(count).toBe(1);
    m.close();
  });

  it('close transitions to closed and stops reconnecting', () => {
    const m = createSseManager({
      EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
    });
    m.close();
    expect(m.getStatus()).toBe('closed');
    vi.advanceTimersByTime(STALE_MS * 2);
    // Still closed, no new instances spun up.
    expect(FakeEventSource.instances.length).toBe(1);
  });
});
