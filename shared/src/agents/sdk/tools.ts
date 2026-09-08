// The Pitchbox MCP tool set lives in `cli/src/mcp/tool-set.ts`: `cli` already
// owns the MCP surface and its SDK dependency, and `shared` stays the leaf
// workspace every other one imports rather than the other way around (see
// AGENTS.md, "DB access is centralised in shared"). This module re-exports
// the same name and signature #416's runner imports via a lazy `import()`,
// so `shared` never declares a workspace dependency on `cli`.

/**
 * Session binding for the Pitchbox MCP tools: which run, campaign, or project
 * this tool set is scoped to.
 */
export interface PitchboxToolSetArgs {
  runId?: number;
  campaignId?: number;
  projectId?: number;
}

export interface PitchboxToolSet {
  /** The AI SDK tool set, as returned by the MCP client's `tools()`. */
  tools: Record<string, unknown>;
  /** Releases both ends of the in-memory MCP connection. */
  close(): Promise<void>;
}

interface ToolSetModule {
  createPitchboxToolSet(args?: PitchboxToolSetArgs): Promise<PitchboxToolSet>;
}

async function importToolSetModule(): Promise<ToolSetModule> {
  // A bundled build (the web SSR build, once it declares the dependency)
  // resolves the package specifier via cli's own exports map; tsx/vitest -
  // where nothing gets bundled and no workspace dependency is declared -
  // falls back to the source path under the umbrella. Both throw when cli's
  // tool-set module is genuinely missing; the caller below wraps that into
  // an actionable error.
  try {
    // @ts-expect-error cli owns the MCP surface; shared does not declare a
    // dependency on it (see the module comment above) - resolved at runtime
    // via cli's exports map when present, tsx/vitest fallback below.
    return (await import('@pitchbox/cli/mcp/tool-set')) as ToolSetModule;
  } catch (primaryErr) {
    try {
      const spec = ['..', '..', '..', '..', 'cli', 'src', 'mcp', 'tool-set.js'].join('/');
      // Intentionally dynamic (tsx/vitest-only fallback); tell Vite not to try to analyze it.
      return (await import(/* @vite-ignore */ spec)) as ToolSetModule;
    } catch {
      // The path fallback only applies to the unbundled tsx/vitest case; in
      // a bundled build it never resolves. Surface the primary error - it's
      // the real cause.
      throw primaryErr;
    }
  }
}

/**
 * Bridges the Pitchbox MCP server to the Vercel AI SDK's tool interface for
 * the in-process SDK runner (#415/#416). See `cli/src/mcp/tool-set.ts` for
 * the real implementation and its doc comment - this function only resolves
 * that module and delegates.
 */
export async function createPitchboxToolSet(
  args: PitchboxToolSetArgs = {},
): Promise<PitchboxToolSet> {
  let mod: ToolSetModule;
  try {
    mod = await importToolSetModule();
  } catch (err) {
    throw new Error(
      'Pitchbox MCP tool set not available - expected cli/src/mcp/tool-set.ts in this checkout. ' +
        String(err instanceof Error ? err.message : err),
      { cause: err },
    );
  }
  return mod.createPitchboxToolSet(args);
}
