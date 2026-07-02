import { Command } from 'commander';
import { fetchListings, type HnListing } from '@pitchbox/shared/platforms/hackernews';
import { ok, fail } from '../lib/output.js';

export const HN_LISTINGS: HnListing[] = ['top', 'new', 'best', 'ask', 'show'];

// Fetch Hacker News stories from a listing, optionally filtered by query.
// Extracted so both the CLI and the Pitchbox MCP server share it. Hits the
// public HN Algolia API; returns data or throws.
export async function searchHn(
  listing: HnListing,
  query: string | undefined,
  limit: number,
): Promise<{ count: number; items: Awaited<ReturnType<typeof fetchListings>> }> {
  if (!HN_LISTINGS.includes(listing)) throw new Error(`unknown listing: ${listing}`);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('limit must be a positive number');
  const items = await fetchListings({ listing, query, limit });
  return { count: items.length, items };
}

export function registerHnCommands(program: Command) {
  program
    .command('hn:search')
    .description('Fetch Hacker News stories from a listing, optionally filtered by query.')
    .option('--listing <name>', 'top | new | best | ask | show', 'top')
    .option('--query <text>', 'case-insensitive substring match on title/text')
    .option('--limit <n>', 'max items to return', '30')
    .action(async (opts: { listing?: string; query?: string; limit?: string }) => {
      try {
        ok(
          await searchHn(
            (opts.listing ?? 'top') as HnListing,
            opts.query,
            Number(opts.limit ?? 30),
          ),
        );
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });
}
