import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A test that reads a credential out of the developer's home directory passes
 * on the machine that holds the credential and fails everywhere else. That is
 * not a hypothetical: on 2026-09-09 three billing tests read
 * `~/.config/pitchbox-stripe-test.key`, went green on every PR (the PR path
 * skips `Tests (Postgres)`), and turned `main` red with
 * `ENOENT /home/runner/.config/pitchbox-stripe-test.key` the moment the full
 * suite ran on the trunk. The live checks moved to `scripts/stripe-probe.ts`,
 * which is a script somebody runs on purpose, and the assertions that stayed
 * in the suite read a committed recording instead.
 *
 * So this guard exists to stop the same shape coming back: a test file may not
 * reach into a home directory, and it may not read one of this box's known
 * credential paths. It is deliberately a source scan rather than a runtime
 * check, because the failure it prevents is one no runtime check can see from
 * the machine that has the file.
 *
 * If a check genuinely needs a real credential, it is a script under
 * `scripts/`, and the suite asserts against a recording of what that script
 * observed. Do not add an exemption here; the exemption is the bug.
 */

const ROOT = join(import.meta.dirname, '..');
const TEST_DIRS = ['tests', 'shared/tests', 'web/tests', 'cli/tests', 'daemon/tests', 'extension/tests'];

/** `homedir()` and `os.homedir`, `$HOME` interpolation, a literal `~/`, and the
 * credential paths this box actually holds. */
const FORBIDDEN: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bhomedir\s*\(/, what: 'os.homedir()' },
  { pattern: /process\.env\.HOME\b/, what: 'process.env.HOME' },
  { pattern: /['"`]~\//, what: 'a literal ~/ path' },
  { pattern: /\.config\/pitchbox-stripe/, what: 'the Stripe key path' },
  { pattern: /\.config\/pitchbox\/github-app/, what: 'the GitHub App key path' },
  { pattern: /\.config\/resend\//, what: 'the Resend admin token path' },
  { pattern: /\.config\/cloudflare\//, what: 'the Cloudflare token path' },
  { pattern: /\.claude\/\.credentials/, what: "Claude's credential file" },
];

/** Good enough for this job: block comments and line comments, neither of
 * which can legitimately contain a string this scan cares about. A `//` inside
 * a string literal (a URL) is left alone by requiring the line comment to be
 * preceded by start-of-line or whitespace and not by a colon. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/[^\n]*/g, '$1');
}

function testFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(abs, entry);
    if (statSync(path).isDirectory()) {
      found.push(...testFiles(join(dir, entry)));
    } else if (entry.endsWith('.test.ts')) {
      found.push(join(dir, entry));
    }
  }
  return found;
}

const files = TEST_DIRS.flatMap(testFiles).filter(
  (f) => !f.endsWith('no-local-credentials-in-tests.test.ts'),
);

describe('no test reads a credential from a developer home directory', () => {
  it('finds the test files to scan, rather than passing on an empty set', () => {
    // Without this, a broken directory list would make every assertion below
    // vacuously true, which is the failure mode of every source-scanning test.
    expect(files.length).toBeGreaterThan(200);
  });

  it.each(files)('%s reads no local credential', (relative) => {
    // Comments are stripped first, and that is not cosmetic: the two files
    // this guard was written for now carry a comment explaining why the live
    // check moved to a script, and naming the path in prose must not be the
    // thing that fails the build. What matters is code that reaches for it.
    const source = withoutComments(readFileSync(join(ROOT, relative), 'utf8'));
    const hits = FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(({ what }) => what);
    expect(hits).toEqual([]);
  });
});
