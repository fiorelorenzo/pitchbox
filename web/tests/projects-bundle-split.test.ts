import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Static-analysis guard for issue #232: /projects/[id] used to statically pull
// in bytemd (+ codemirror, remark/micromark, unified) via MarkdownEditor even
// on read-only visits, making that route's client chunk ~40% of all app JS.
// These checks assert the import shape stays split - they don't execute any
// code, so they're safe to run without the Postgres-backed test fixtures.

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

// Matches `import Foo from '...'` / `import { Foo } from '...'` style static
// imports, but not `import(...)` dynamic import expressions.
function hasStaticImportOf(source: string, specifierSuffix: string): boolean {
  const staticImportRe = /^\s*import\s+[^(][^;]*from\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = staticImportRe.exec(source))) {
    if (match[1].endsWith(specifierSuffix)) return true;
  }
  return false;
}

describe('projects/[id] does not statically bundle the markdown editor stack', () => {
  it('ProjectOverviewTab.svelte only reaches MarkdownEditor via a dynamic import()', () => {
    const source = readSource('src/lib/components/projects/ProjectOverviewTab.svelte');
    expect(hasStaticImportOf(source, 'MarkdownEditor.svelte')).toBe(false);
    expect(source).toMatch(/#await\s+import\(\s*['"][^'"]*MarkdownEditor\.svelte['"]\s*\)/);
  });

  it('the +page.svelte tree has no remaining static import of MarkdownEditor', () => {
    const files = [
      'src/routes/projects/[id]/+page.svelte',
      'src/lib/components/projects/ProjectOverviewTab.svelte',
      'src/lib/components/projects/ProjectAccountsTab.svelte',
      'src/lib/components/projects/ProjectTemplatesTab.svelte',
      'src/lib/components/projects/ProjectInsightsTab.svelte',
    ];
    for (const file of files) {
      const source = readSource(file);
      expect(hasStaticImportOf(source, 'MarkdownEditor.svelte')).toBe(false);
      expect(hasStaticImportOf(source, 'bytemd')).toBe(false);
    }
  });

  it('MarkdownEditor.svelte remains the sole component with bytemd as a direct dependency', () => {
    // Guards against a future change re-introducing bytemd elsewhere and
    // silently regressing a different route instead.
    const source = readSource('src/lib/components/MarkdownEditor.svelte');
    expect(source).toMatch(/from\s+['"]bytemd['"]/);
  });

  it('Markdown.svelte (the read-only renderer) lazy-loads marked and dompurify', () => {
    const source = readSource('src/lib/components/Markdown.svelte');
    expect(hasStaticImportOf(source, 'marked')).toBe(false);
    expect(hasStaticImportOf(source, 'dompurify')).toBe(false);
    expect(source).toMatch(/import\(\s*['"]marked['"]\s*\)/);
    expect(source).toMatch(/import\(\s*['"]dompurify['"]\s*\)/);
    // Sanitisation must not be dropped while we're at it.
    expect(source).toMatch(/DOMPurify\.sanitize\(/);
  });
});
