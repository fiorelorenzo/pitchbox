import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import type { Db } from '@pitchbox/shared/db';
import { findOrgBySlug } from '@pitchbox/shared/orgs';
import { parseLinkedinExportBuffer } from '@pitchbox/shared/voice-import-archive';
import { importVoiceSamples } from '@pitchbox/shared/operator-profile';
import { refreshVoiceProfile } from '@pitchbox/shared/operator-voice-profile';
import { ok, fail } from '../lib/output.js';

// LOR-223: fills the operator's voice corpus in one step from LinkedIn's own
// "Get a copy of your data" export, headlessly - the archive carries
// Shares.csv (posts) and Comments.csv (comments, with the URL of the thing
// commented on), which is the only way today to get more than a handful of
// comments into the corpus without weeks of passive browsing. Capturing
// comments off the page itself is LOR-228, deliberately separate and after
// this one. `web/src/routes/companion/voice/+page.server.ts`'s
// `importVoice` action is the same import for an operator without a
// terminal - both call `parseLinkedinExportBuffer`/`importVoiceSamples` so
// the two paths cannot drift.

async function linkedinPlatformId(db: Db): Promise<number> {
  const [row] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  if (!row) throw new Error('linkedin platform not found');
  return row.id;
}

const NUMERIC_ID = /^\d+$/;

/** `--org` accepts either an organization id or a slug; omitted falls back
 * to the 'default' organization seeded by seed-core, the same self-host
 * posture `utility.ts`'s `resolveOrgId` already takes for a CLI command
 * with no run/project to resolve one from. */
async function resolveImportOrgId(db: Db, org?: string): Promise<number> {
  if (org) {
    const trimmed = org.trim();
    if (NUMERIC_ID.test(trimmed)) return Number(trimmed);
    const found = await findOrgBySlug(db, trimmed);
    if (!found) throw new Error(`Unknown organization "${org}"`);
    return found.id;
  }
  const fallback = await findOrgBySlug(db, 'default');
  if (!fallback) throw new Error('No default organization on file - pass --org');
  return fallback.id;
}

export interface VoiceImportInput {
  /** Path to a LinkedIn export zip, or a single already-extracted CSV. */
  path: string;
  /** Organization id or slug; defaults to the 'default' organization. */
  org?: string;
}

export interface VoiceImportResult {
  organizationId: number;
  /** Rows the parser produced, before dedup - stable across a re-run of the
   * same file, which is what proves a second import is a no-op rather than
   * a parser that silently returns less the second time. */
  parsed: number;
  /** New rows actually written. 0 on a re-import of the same export. */
  inserted: number;
  byGenre: { post: number; comment: number };
}

export async function voiceImportRun(input: VoiceImportInput): Promise<VoiceImportResult> {
  const db = getDb();
  const organizationId = await resolveImportOrgId(db, input.org);
  const buffer = await readFile(input.path);
  const items = parseLinkedinExportBuffer(buffer, basename(input.path));
  const platformId = await linkedinPlatformId(db);
  const { inserted, byGenre } = await importVoiceSamples(db, organizationId, platformId, items);
  // Onboarding in one step: a fresh import is exactly the case where the
  // corpus just crossed MIN_ITEMS_TO_DERIVE, and the whole point is that
  // the operator does not have to separately remember to refresh.
  if (inserted > 0) {
    await refreshVoiceProfile(db, organizationId);
  }
  return { organizationId, parsed: items.length, inserted, byGenre };
}

export function registerVoiceCommands(program: Command) {
  program
    .command('voice:import')
    .description(
      'Import voice-corpus samples from a LinkedIn "Get a copy of your data" export (zip or a single Shares.csv/Comments.csv)',
    )
    .argument('<path>', 'path to the export zip or CSV')
    .option(
      '--org <slugOrId>',
      'organization to import into (defaults to the default organization)',
    )
    .action(async (path: string, opts: { org?: string }) => {
      try {
        ok(await voiceImportRun({ path, org: opts.org }));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });
}
