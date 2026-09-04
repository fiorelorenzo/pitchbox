import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkAll,
  checkAlarmsReachability,
  checkContentScriptStorageReads,
  linkedinContentScriptFiles,
  checkHostPermissions,
  checkLinkedinPlatformNetworkCalls,
  checkNetworkTargets,
  checkSyntheticInteractions,
  defaultRepoPaths,
} from './linkedin-boundary.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_PATHS = defaultRepoPaths(REPO_ROOT);
const FIXTURES = path.join(REPO_ROOT, 'tests', 'compliance', 'fixtures');

describe('linkedin compliance boundary (#308): passes on main as it stands', () => {
  it('finds zero violations across the real repo', async () => {
    const violations = await checkAll(REPO_PATHS);
    expect(violations).toEqual([]);
  });
});

describe('rule 1: no fetch/XMLHttpRequest/sendBeacon toward linkedin/licdn', () => {
  const scanDir = path.join(FIXTURES, 'rule1-fetch-linkedin');

  it('flags a fetch whose target mentions linkedin, and nothing else in the same tree', () => {
    const violations = checkNetworkTargets(scanDir);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe(1);
    expect(violations[0].file).toContain('bad-fetch.ts');
    expect(violations[0].message).toBe(
      'linkedin-compliance rule 1: tests/compliance/fixtures/rule1-fetch-linkedin/content/bad-fetch.ts calls fetch(\'https://www.linkedin.com/voyager/api/feed/updates\') whose target mentions "linkedin"/"licdn"',
    );
  });

  it('passes on the real repo with this rule alone', () => {
    expect(checkNetworkTargets(REPO_PATHS.extensionSrcDir)).toEqual([]);
  });
});

describe('rule 2: no cookie/storage read in a LinkedIn content script', () => {
  const manifestPath = path.join(FIXTURES, 'rule2-content-script-storage', 'manifest.config.ts');

  it('flags document.cookie in a file the fixture manifest registers as a LinkedIn content script', async () => {
    const violations = await checkContentScriptStorageReads(manifestPath);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe(2);
    expect(violations[0].file).toContain('bad-cookie-read.ts');
    expect(violations[0].message).toBe(
      'linkedin-compliance rule 2: tests/compliance/fixtures/rule2-content-script-storage/content/bad-cookie-read.ts reads document.cookie (document.cookie)',
    );
  });

  it('follows a dynamic chrome.scripting.registerContentScripts registration to the file it registers', async () => {
    // The hole this rule shipped with: #348 registered the first real LinkedIn
    // content script at runtime rather than in the manifest (so the LinkedIn
    // grant stays optional, #317), which took it out of the static array this
    // rule derived its scan set from. A planted `document.cookie` in
    // extension/src/content/linkedin-comment.ts then passed 13/13, measured.
    const manifestPath = path.join(FIXTURES, 'rule2-dynamic-registration', 'manifest.config.ts');
    const sourceRoot = path.join(FIXTURES, 'rule2-dynamic-registration', 'src');
    const violations = await checkContentScriptStorageReads(manifestPath, sourceRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe(2);
    expect(violations[0].file).toContain('linkedin-comment.ts');
    expect(violations[0].message).toContain('reads localStorage');
  });

  it('refuses to pass over a LinkedIn-looking script that no registration accounts for', async () => {
    // A scan set that silently empties is the skippable check #308 forbids, in
    // a slower form: it reports green on exactly the file it exists for.
    const manifestPath = path.join(FIXTURES, 'rule2-unaccounted-script', 'manifest.config.ts');
    const sourceRoot = path.join(FIXTURES, 'rule2-unaccounted-script', 'src');
    const violations = await checkContentScriptStorageReads(manifestPath, sourceRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toContain('linkedin-orphan.ts');
    expect(violations[0].message).toContain('would never scan it');
  });

  it('scans the real repo, and the file it scans is the dynamically registered one', async () => {
    const files = await linkedinContentScriptFiles(
      REPO_PATHS.manifestPath,
      REPO_PATHS.extensionSrcDir,
    );
    // Asserting the set is non-empty and names the real script is the assertion
    // that would have caught the hole above; `toEqual([])` on the violations
    // alone passes just as well when nothing was scanned at all.
    expect(files.some((f) => f.endsWith('content/linkedin-comment.ts'))).toBe(true);
    expect(
      await checkContentScriptStorageReads(REPO_PATHS.manifestPath, REPO_PATHS.extensionSrcDir),
    ).toEqual([]);
  });
});

describe('rule 3: no synthetic click/submit/dispatchEvent on a linkedin-dom.ts node', () => {
  const scanDir = path.join(FIXTURES, 'rule3-synthetic-click');
  const domModulePath = path.join(scanDir, 'linkedin-dom.ts');

  it('flags .click() on a node returned by the fixture accessor', () => {
    const violations = checkSyntheticInteractions(scanDir, domModulePath);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe(3);
    expect(violations[0].file).toContain('bad-click.ts');
    expect(violations[0].message).toBe(
      'linkedin-compliance rule 3: tests/compliance/fixtures/rule3-synthetic-click/content/bad-click.ts calls .click() on a node obtained from linkedin-dom.ts',
    );
  });

  it('passes on the real extension source against the real linkedin-dom.ts', () => {
    expect(
      checkSyntheticInteractions(REPO_PATHS.extensionSrcDir, REPO_PATHS.linkedinDomPath),
    ).toEqual([]);
  });
});

describe('rule 4: no chrome.alarms handler reachable from a LinkedIn code path', () => {
  const scanDir = path.join(FIXTURES, 'rule4-alarms-reachable');

  it('flags an alarms handler whose call graph reaches ./linkedin/poll.ts', () => {
    const violations = checkAlarmsReachability(scanDir);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe(4);
    expect(violations[0].file).toContain('background.ts');
    expect(violations[0].message).toBe(
      'linkedin-compliance rule 4: tests/compliance/fixtures/rule4-alarms-reachable/background.ts registers a chrome.alarms.onAlarm handler whose call graph reaches LinkedIn code through tests/compliance/fixtures/rule4-alarms-reachable/linkedin/poll.ts',
    );
  });

  it('passes on the real extension source (the only alarm today is the Reddit dm-sync poller)', () => {
    expect(checkAlarmsReachability(REPO_PATHS.extensionSrcDir)).toEqual([]);
  });
});

describe('rule 5: shared/src/platforms/linkedin/ stays parsing and mapping only', () => {
  const platformDir = path.join(FIXTURES, 'rule5-platform-network-call');

  it('flags a fetch call anywhere under the platform directory, regardless of its target', () => {
    const violations = checkLinkedinPlatformNetworkCalls(platformDir);
    expect(violations).toHaveLength(3);
    const byFile = Object.fromEntries(violations.map((v) => [path.basename(v.file), v]));
    expect(byFile['fetcher.ts'].rule).toBe(5);
    expect(byFile['fetcher.ts'].message).toBe(
      'linkedin-compliance rule 5: tests/compliance/fixtures/rule5-platform-network-call/fetcher.ts calls fetch(...) - this directory must stay parsing and mapping only',
    );
    expect(byFile['xhr.ts'].message).toBe(
      'linkedin-compliance rule 5: tests/compliance/fixtures/rule5-platform-network-call/xhr.ts constructs XMLHttpRequest - this directory must stay parsing and mapping only',
    );
    expect(byFile['http-import.ts'].message).toBe(
      'linkedin-compliance rule 5: tests/compliance/fixtures/rule5-platform-network-call/http-import.ts imports "node:https" - this directory must stay parsing and mapping only',
    );
  });

  it('passes today because shared/src/platforms/linkedin/ does not exist yet on main', () => {
    expect(checkLinkedinPlatformNetworkCalls(REPO_PATHS.linkedinPlatformDir)).toEqual([]);
  });
});

describe('rule 6: host_permissions never includes linkedin (#317 keeps it optional)', () => {
  const manifestPath = path.join(FIXTURES, 'rule6-host-permissions', 'manifest.config.ts');

  it('flags a linkedin entry in the fixture manifest host_permissions', async () => {
    const violations = await checkHostPermissions(manifestPath);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe(6);
    expect(violations[0].message).toBe(
      'linkedin-compliance rule 6: tests/compliance/fixtures/rule6-host-permissions/manifest.config.ts host_permissions includes "https://www.linkedin.com/*" - linkedin must stay an optional grant, never a blanket permission',
    );
  });

  it('passes on the real manifest', async () => {
    expect(await checkHostPermissions(REPO_PATHS.manifestPath)).toEqual([]);
  });
});
