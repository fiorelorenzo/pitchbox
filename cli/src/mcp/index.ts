#!/usr/bin/env node
import { config } from 'dotenv';
import { resolve } from 'node:path';
// mcp/ is one level deeper than the CLI entry, so reach the repo root with three ascents.
config({ path: resolve(import.meta.dirname ?? '.', '..', '..', '..', '.env') });
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPitchboxMcpServer } from './server.js';

async function main() {
  const server = createPitchboxMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }) + '\n');
  process.exit(1);
});
