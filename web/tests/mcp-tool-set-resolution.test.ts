import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPitchboxToolSet } from '@pitchbox/shared/agents/sdk/tools';

// #491: the SDK runner loads the Pitchbox MCP tool set from `cli` through a
// lazy `import('@pitchbox/cli/mcp/tool-set')`, because `shared` stays the leaf
// workspace and does not declare a dependency on `cli`. That specifier can
// only resolve from a workspace that *does* declare it, and until this test
// existed nothing did: every local run resolved through the source-path
// fallback, which a bundled build never reaches. The deployed cloud edition
// therefore failed every campaign run with "Cannot find package
// '@pitchbox/cli'", measured on preview at run 25.
//
// This asserts the property the deployment needs: the process that dispatches
// a run can resolve the tool set by package specifier, not only by walking up
// the umbrella's directories.

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const requireFromWeb = createRequire(new URL('../package.json', import.meta.url));

describe('Pitchbox MCP tool set resolution (#491)', () => {
  it('resolves by package specifier from the web workspace, not only by source path', () => {
    // `require.resolve` walks the same node_modules chain the bundled server
    // does at runtime, which is exactly what the source-path fallback hides.
    expect(() => requireFromWeb.resolve('@pitchbox/cli/mcp/tool-set')).not.toThrow();
  });

  it('is a declared dependency of every workspace that dispatches a run', () => {
    // The web server and the daemon both call `dispatchRun`, and a run
    // dispatched from either has to reach the tool set. A dependency that
    // exists only in one of them fails in production on whichever process
    // happens to pick up the campaign.
    for (const workspace of ['web', 'daemon']) {
      const pkg: unknown = JSON.parse(
        readFileSync(new URL(`../../${workspace}/package.json`, import.meta.url), 'utf8'),
      );
      const deps =
        pkg && typeof pkg === 'object' && 'dependencies' in pkg ? pkg.dependencies : undefined;
      const has =
        deps && typeof deps === 'object' && '@pitchbox/cli' in deps
          ? deps['@pitchbox/cli']
          : undefined;
      expect(has, `${workspace} must declare @pitchbox/cli`).toBe('workspace:*');
    }
  });

  it('hands back the real tool set through the loader the runner uses', async () => {
    // Not a resolution check: the loader's own error message is reassuring
    // even when it is wrapping a failure, so drive it and look at the tools.
    const set = await createPitchboxToolSet({});
    try {
      expect(Object.keys(set.tools).length).toBeGreaterThan(20);
      expect(Object.keys(set.tools)).toContain('drafts_create');
    } finally {
      await set.close();
    }
    expect(webRoot).toContain('web');
  });
});
