type Listener = (evt: { kind: string; data: unknown }) => void;
const listeners = new Set<Listener>();

export function emit(kind: string, data: unknown) {
  for (const l of listeners) {
    try {
      l({ kind, data });
    } catch (err) {
      // A bad listener must not poison the bus for other listeners.
      listeners.delete(l);
      console.error('SSE listener threw, removed from bus:', err);
    }
  }
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
