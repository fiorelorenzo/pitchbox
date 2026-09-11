/**
 * LOR-263's literal-scan guard. See `src/lib/i18n/literal-scan.ts` for what
 * the scan catches, what it cannot, and why its file list is scoped rather
 * than wholesale `routes/**`/`components/**`.
 */
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scanSource,
  SCAN_ROUTE_DIRS,
  SCAN_ROUTE_FILES,
  SCAN_COMPONENT_FILES,
  ALLOWLIST,
} from '../src/lib/i18n/literal-scan';

const SRC_ROOT = join(__dirname, '..', 'src');

function listSvelteFiles(relDir: string): string[] {
  const abs = join(SRC_ROOT, relDir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const entryRel = join(relDir, entry);
    const entryAbs = join(SRC_ROOT, entryRel);
    if (statSync(entryAbs).isDirectory()) out.push(...listSvelteFiles(entryRel));
    else if (entry.endsWith('.svelte')) out.push(entryRel);
  }
  return out;
}

function scanTargetFiles(): string[] {
  const files = new Set<string>();
  for (const dir of SCAN_ROUTE_DIRS) for (const f of listSvelteFiles(dir)) files.add(f);
  for (const f of [...SCAN_ROUTE_FILES, ...SCAN_COMPONENT_FILES]) files.add(f);
  return [...files].sort();
}

type Violation = { file: string; kind: 'text' | 'attr'; value: string };

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const relFile of scanTargetFiles()) {
    const source = readFileSync(join(SRC_ROOT, relFile), 'utf8');
    const allowed = new Set(ALLOWLIST[relFile] ?? []);
    for (const hit of scanSource(source)) {
      if (allowed.has(hit.value)) continue;
      violations.push({ file: relFile, kind: hit.kind, value: hit.value });
    }
  }
  return violations;
}

describe('the literal-scan guard (LOR-263)', () => {
  it('finds no unallowlisted English literal across the converted surfaces', () => {
    // Not a count assertion: every legitimate exception is named and
    // reasoned about in ALLOWLIST, so anything left here is a real miss.
    expect(findViolations()).toEqual([]);
  });

  it('scans at least the eight route trees this PR converted, not an empty list', () => {
    const files = scanTargetFiles();
    for (const surface of [
      'routes/people',
      'routes/conversations',
      'routes/blocklist',
      'routes/playbooks',
      'routes/notifications',
      'routes/analytics',
      'routes/audit',
      'routes/verify',
    ]) {
      expect(files.some((f) => f.startsWith(surface))).toBe(true);
    }
  });

  it('fails on a deliberately reintroduced English literal', () => {
    const reintroduced = `
<script lang="ts">
  let count = 0;
</script>

<PageHeader title="People" description="Everyone your campaigns have reached." />
<button aria-label="Remove this entry">Remove</button>
`;
    const hits = scanSource(reintroduced);
    const values = hits.map((h) => h.value);
    expect(values).toContain('Everyone your campaigns have reached.');
    expect(values).toContain('Remove this entry');
    expect(values).toContain('Remove');
    // A converted equivalent - t()/badgeLabel() calls live inside `{...}`,
    // which the scan skips - produces no hits at all.
    const converted = `
<PageHeader title={t(locale, 'people.title')} description={t(locale, 'people.seo-description')} />
<button aria-label={t(locale, 'blocklist.aria-remove')}>{t(locale, 'blocklist.remove-button')}</button>
`;
    expect(scanSource(converted)).toEqual([]);
  });
});
