import { getDb, schema } from '@pitchbox/shared/db';

async function main() {
  const db = getDb();
  try {
    await db.insert(schema.stagingScoutCandidates).values({
      runId: 8,
      raw: { hello: 'world' },
    });
    console.log('inserted ok');
  } catch (err: any) {
    console.log('message:', err?.message);
    console.log('code:', err?.code);
    console.log('detail:', err?.detail);
    console.log('cause:', err?.cause);
    console.log('cause.message:', err?.cause?.message);
    console.log('cause.code:', err?.cause?.code);
    console.log('cause.detail:', err?.cause?.detail);
    console.log('cause.constraint:', err?.cause?.constraint);
    console.log('cause.table:', err?.cause?.table);
    console.log('cause.column:', err?.cause?.column);
  }
  process.exit(0);
}
main();
