import { getDb, schema } from '@pitchbox/shared/db';
const db = getDb();
const runs = await db.select().from(schema.runs);
console.log('runs count:', runs.length);
console.log(
  'ids:',
  runs.map((r) => r.id),
);
console.log('last 3:', runs.slice(-3));
process.exit(0);
