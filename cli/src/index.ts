#!/usr/bin/env node
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(import.meta.dirname ?? '.', '..', '..', '.env') });
import { Command } from 'commander';

const program = new Command();
program.name('pitchbox').description('Pitchbox outreach CLI').version('0.0.0');

async function main() {
  const { registerRunCommands } = await import('./commands/run.js');
  const { registerDraftCommands } = await import('./commands/drafts.js');
  const { registerRedditCommands } = await import('./commands/reddit.js');
  const { registerUtilityCommands } = await import('./commands/utility.js');
  registerRunCommands(program);
  registerDraftCommands(program);
  registerRedditCommands(program);
  registerUtilityCommands(program);
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }) + '\n');
  process.exit(1);
});
