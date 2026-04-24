import { subscribe } from '$lib/server/events.js';

export async function GET() {
  let closed = false;
  let unsub: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (unsub) unsub();
      };

      const send = (evt: { kind: string; data: unknown }) => {
        if (closed) return;
        try {
          controller.enqueue(
            new TextEncoder().encode(`event: ${evt.kind}\ndata: ${JSON.stringify(evt.data)}\n\n`),
          );
        } catch {
          // Controller closed (client disconnected) — drop listener.
          cleanup();
        }
      };

      unsub = subscribe(send);
      send({ kind: 'hello', data: { at: new Date().toISOString() } });
      timer = setInterval(() => send({ kind: 'ping', data: {} }), 25_000);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
      if (unsub) unsub();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
