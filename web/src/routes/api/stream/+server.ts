import { subscribe } from '$lib/server/events.js';

// 2 KiB padding forces browsers (Chrome especially) to start dispatching events
// immediately instead of buffering until they have enough body.
const PADDING = ': ' + ' '.repeat(2048) + '\n\n';

export async function GET() {
  let closed = false;
  let unsub: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (unsub) unsub();
      };

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      const send = (evt: { kind: string; data: unknown }) => {
        write(`event: ${evt.kind}\ndata: ${JSON.stringify(evt.data)}\n\n`);
      };

      // Initial padding + hello so browsers stop buffering the response.
      write(PADDING);
      send({ kind: 'hello', data: { at: new Date().toISOString() } });

      unsub = subscribe(send);
      // Heartbeat every 15s (smaller than the usual 25s so intermediaries keep alive).
      timer = setInterval(() => write(': ping\n\n'), 15_000);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
      if (unsub) unsub();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Hint to reverse proxies (nginx) not to buffer.
      'x-accel-buffering': 'no',
      // Disable compression so chunks flush.
      'content-encoding': 'identity',
    },
  });
}
