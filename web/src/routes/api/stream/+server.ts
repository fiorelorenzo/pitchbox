import { subscribe } from '$lib/server/events.js';

export async function GET() {
	const stream = new ReadableStream({
		start(controller) {
			const send = (evt: { kind: string; data: unknown }) => {
				controller.enqueue(
					new TextEncoder().encode(
						`event: ${evt.kind}\ndata: ${JSON.stringify(evt.data)}\n\n`,
					),
				);
			};
			const unsub = subscribe(send);
			send({ kind: 'hello', data: { at: new Date().toISOString() } });
			const timer = setInterval(() => send({ kind: 'ping', data: {} }), 25_000);
			// Controller has no abort listener in Node streams — rely on close.
			(controller as unknown as { _pitchboxCleanup?: () => void })._pitchboxCleanup = () => {
				clearInterval(timer);
				unsub();
			};
		},
		cancel() {
			// best-effort cleanup
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
