import { Command } from 'commander';
import { fetchListings, type HnListing } from '@pitchbox/shared/platforms/hackernews';
import { ok, fail } from '../lib/output.js';

const LISTINGS: HnListing[] = ['top', 'new', 'best', 'ask', 'show'];

export function registerHnCommands(program: Command) {
  program
    .command('hn:search')
    .description('Fetch Hacker News stories from a listing, optionally filtered by query.')
    .option('--listing <name>', 'top | new | best | ask | show', 'top')
    .option('--query <text>', 'case-insensitive substring match on title/text')
    .option('--limit <n>', 'max items to return', '30')
    .action(async (opts: { listing?: string; query?: string; limit?: string }) => {
      const listing = (opts.listing ?? 'top') as HnListing;
      if (!LISTINGS.includes(listing)) return fail(`unknown listing: ${listing}`);
      const limit = Number(opts.limit ?? 30);
      if (!Number.isFinite(limit) || limit <= 0) return fail('--limit must be a positive number');
      try {
        const items = await fetchListings({ listing, query: opts.query, limit });
        return ok({ count: items.length, items });
      } catch (err) {
        return fail(String((err as Error)?.message ?? err));
      }
    });
}
