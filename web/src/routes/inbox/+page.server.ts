import { getDb, schema } from '$lib/server/db.js';
import { and, eq, desc, type SQL } from 'drizzle-orm';

export async function load({ url }: { url: URL }) {
	const state = url.searchParams.get('state') ?? 'pending_review';
	const kind = url.searchParams.get('kind');
	const db = getDb();
	const filters: SQL[] = [eq(schema.drafts.state, state)];
	if (kind) filters.push(eq(schema.drafts.kind, kind));
	const drafts = await db
		.select()
		.from(schema.drafts)
		.where(and(...filters))
		.orderBy(desc(schema.drafts.createdAt))
		.limit(200);
	return { drafts, state, kind };
}
