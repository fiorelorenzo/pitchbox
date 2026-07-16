import { describe, expect, it, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { GET } from '../src/routes/api/stream/+server.js';
import { emit } from '../src/lib/server/events.js';

/**
 * Cross-tenant SSE isolation (issue #136 redo): every emit() call site must
 * tag its event with the owning org, and /api/stream must only relay an event
 * to a subscriber whose active org matches (or the event is org-agnostic,
 * i.e. orgId is null/omitted). This drives the real GET handler and the real
 * event bus - not a hand-fabricated bypass - so it would have caught the
 * original bug where only runner.ts was tagged.
 */

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

function streamEvent(orgId: number): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' }, user: { id: 1, username: 'x' } },
    request: new Request('http://x/api/stream'),
  } as unknown as RequestEvent;
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done || !value) return '';
  return new TextDecoder().decode(value);
}

describe('GET /api/stream tenant scoping', () => {
  beforeEach(reset);

  it('delivers drafts:changed only to the subscriber whose org matches', async () => {
    const db = getDb();
    const [orgA] = await db
      .insert(schema.organizations)
      .values({ slug: 'sse-a', name: 'a' })
      .returning();
    const [orgB] = await db
      .insert(schema.organizations)
      .values({ slug: 'sse-b', name: 'b' })
      .returning();

    const res = await GET(streamEvent(orgA.id));
    expect(res.body).not.toBeNull();
    const reader = res.body!.getReader();
    await readChunk(reader); // padding
    await readChunk(reader); // hello

    // Cross-tenant event must never reach org A's subscriber.
    emit('drafts:changed', { id: 999 }, orgB.id);
    // Same-org event must reach it.
    emit('drafts:changed', { id: 1 }, orgA.id);

    const delivered = await readChunk(reader);
    expect(delivered).toContain('event: drafts:changed');
    expect(delivered).toContain('"id":1');
    expect(delivered).not.toContain('999');

    await reader.cancel();
  });

  it('delivers run:started only to the subscriber whose org matches', async () => {
    const db = getDb();
    const [orgA] = await db
      .insert(schema.organizations)
      .values({ slug: 'sse-run-a', name: 'a' })
      .returning();
    const [orgB] = await db
      .insert(schema.organizations)
      .values({ slug: 'sse-run-b', name: 'b' })
      .returning();

    const res = await GET(streamEvent(orgA.id));
    const reader = res.body!.getReader();
    await readChunk(reader); // padding
    await readChunk(reader); // hello

    emit('run:started', { runId: 999 }, orgB.id);
    emit('run:started', { runId: 1 }, orgA.id);

    const delivered = await readChunk(reader);
    expect(delivered).toContain('event: run:started');
    expect(delivered).toContain('"runId":1');
    expect(delivered).not.toContain('999');

    await reader.cancel();
  });

  it('delivers an org-agnostic event (no orgId) to every subscriber', async () => {
    const db = getDb();
    const [orgA] = await db
      .insert(schema.organizations)
      .values({ slug: 'sse-system-a', name: 'a' })
      .returning();

    const res = await GET(streamEvent(orgA.id));
    const reader = res.body!.getReader();
    await readChunk(reader); // padding
    await readChunk(reader); // hello

    emit('system:announcement', { text: 'hi' });

    const delivered = await readChunk(reader);
    expect(delivered).toContain('event: system:announcement');

    await reader.cancel();
  });
});
