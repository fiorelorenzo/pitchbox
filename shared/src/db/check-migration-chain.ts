/**
 * CLI wrapper for `checkMigrationChain`, wired as `pnpm run migrations:check`
 * and run by CI's `quality` job. Takes an optional directory so it can be
 * pointed at something other than this repo's own migrations.
 */
import { checkMigrationChain, MIGRATIONS_DIR } from './migration-chain.js';

const dir = process.argv[2] ?? MIGRATIONS_DIR;
const problems = checkMigrationChain(dir);

if (problems.length > 0) {
  console.error(`migration metadata is inconsistent in ${dir}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log('migration metadata: chain, order and identity all sound');
