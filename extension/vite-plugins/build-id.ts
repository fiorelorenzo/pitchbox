import { execFileSync } from 'node:child_process';

/**
 * The commit a bundle was built from, so a loaded extension can be told apart
 * from another one carrying the same `version`.
 *
 * The manifest version only moves on a release commit, and every build in
 * between reports it unchanged: an unpacked bundle built at 18:52 and one
 * built after three more merges both say `0.17.0` in `chrome://extensions`,
 * with nothing on either surface to tell them apart. That cost a full round
 * of "the fix is not there" on 2026-09-10, twice, when the installed bundle
 * simply predated the merge it was being judged on.
 *
 * `PITCHBOX_BUILD_ID` wins when set, so a CI or container build with no git
 * checkout can stamp its own. Otherwise this reads the checkout, and appends
 * `-dirty` when the tree carries uncommitted changes, since a bundle built
 * from a dirty tree is not the commit it names.
 */
export function resolveBuildId(cwd: string = process.cwd()): string | null {
  const fromEnv = process.env.PITCHBOX_BUILD_ID?.trim();
  if (fromEnv) return fromEnv;

  const sha = git(['rev-parse', '--short=7', 'HEAD'], cwd);
  if (!sha) return null;

  // `--quiet` exits non-zero when the tree differs from HEAD, which `git`
  // below reports as null. Untracked files are deliberately not counted: a
  // stray note in the worktree does not change what was compiled.
  const clean = git(['diff', '--quiet', 'HEAD'], cwd) !== null;
  return clean ? sha : `${sha}-dirty`;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // No git, no checkout, or a non-zero exit (which is how `diff --quiet`
    // reports a dirty tree). Never fatal: a bundle without a build id is
    // worse to debug, not unbuildable.
    return null;
  }
}

/**
 * What both the manifest's `version_name` and the side panel's About card
 * show: the release version, plus the commit when there is one.
 */
export function versionLabel(version: string, buildId: string | null): string {
  return buildId ? `${version} (${buildId})` : version;
}
