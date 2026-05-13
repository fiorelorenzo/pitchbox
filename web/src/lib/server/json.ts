import { error } from '@sveltejs/kit';
import type { z } from 'zod';

/**
 * Parse a JSON request body against a zod schema. Returns the typed value or
 * throws a SvelteKit error with a consistent shape:
 *   { error: 'invalid_body', issues: [...] }
 *
 * Use this instead of `await request.json()` followed by an ad-hoc
 * `safeParse` block - the response shape stays the same across every API
 * endpoint, so clients can rely on it.
 */
export async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw error(400, JSON.stringify({ error: 'invalid_json' }));
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw error(400, JSON.stringify({ error: 'invalid_body', issues: parsed.error.issues }));
  }
  return parsed.data;
}
