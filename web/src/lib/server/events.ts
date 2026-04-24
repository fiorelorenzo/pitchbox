type Listener = (evt: { kind: string; data: unknown }) => void;
const listeners = new Set<Listener>();

export function emit(kind: string, data: unknown) {
	for (const l of listeners) l({ kind, data });
}

export function subscribe(l: Listener): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}
