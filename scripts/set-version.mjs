#!/usr/bin/env node
// Keep the shared version in lockstep across all workspaces (AGENTS.md: "All
// workspaces share a single version"). The extension manifest reads its
// version from extension/package.json, so a missed file silently desyncs the
// extension from the rest of the app. This makes the invariant enforceable:
//
//   node scripts/set-version.mjs 0.10.6   # bump every workspace atomically
//   node scripts/set-version.mjs --check  # fail if any workspace has drifted
//
// The bump edits only the top-level "version" field (a targeted replace, so it
// never reformats the file); prettier still owns formatting.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'package.json',
  'shared/package.json',
  'cli/package.json',
  'daemon/package.json',
  'web/package.json',
  'extension/package.json',
];

function versionOf(rel) {
  const m = readFileSync(join(root, rel), 'utf8').match(/"version":\s*"([^"]*)"/);
  return m ? m[1] : null;
}

const arg = process.argv[2];

if (arg === '--check') {
  const versions = FILES.map((f) => [f, versionOf(f)]);
  const distinct = new Set(versions.map(([, v]) => v));
  if (distinct.size === 1 && !distinct.has(null)) {
    console.log(`OK: all workspaces at ${[...distinct][0]}`);
    process.exit(0);
  }
  console.error('Workspace versions have drifted:');
  for (const [f, v] of versions) console.error(`  ${f}: ${v}`);
  process.exit(1);
}

if (!arg || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg)) {
  console.error('Usage: node scripts/set-version.mjs <x.y.z> | --check');
  process.exit(1);
}

for (const rel of FILES) {
  const p = join(root, rel);
  const src = readFileSync(p, 'utf8');
  const next = src.replace(/("version":\s*)"[^"]*"/, `$1"${arg}"`);
  if (next === src) {
    console.error(`  !! no "version" field found in ${rel}`);
    process.exit(1);
  }
  writeFileSync(p, next);
  console.log(`set ${rel} -> ${arg}`);
}
