type Listener = (evt: { kind: string; data: unknown }) => void;

// Every subscriber is pinned to the org id it connected with (its active
// org, resolved once at subscribe time by the /api/stream route). `emit`
// tags each event with the org it belongs to; a null/omitted orgId means
// "system-wide" (delivered to every subscriber regardless of org).
interface Subscription {
  listener: Listener;
  orgId: number;
}
const listeners = new Set<Subscription>();

/**
 * Broadcast an event on the realtime bus, tenant-scoped by `orgId`.
 *
 * Tenant-scoped event kinds (drafts:changed, run:*, project:*) MUST pass the
 * owning org id so cross-tenant subscribers never see them. Passing null (or
 * omitting the argument) marks the event system-wide, delivered to every
 * subscriber - only use that for events that carry no tenant data.
 */
export function emit(kind: string, data: unknown, orgId: number | null = null) {
  for (const sub of listeners) {
    if (orgId != null && sub.orgId !== orgId) continue;
    try {
      sub.listener({ kind, data });
    } catch (err) {
      // A bad listener must not poison the bus for other listeners.
      listeners.delete(sub);
      console.error('SSE listener threw, removed from bus:', err);
    }
  }
}

/** Subscribe to the bus scoped to `orgId` (the subscriber's active org). */
export function subscribe(orgId: number, l: Listener): () => void {
  const sub: Subscription = { listener: l, orgId };
  listeners.add(sub);
  return () => listeners.delete(sub);
}
