import type { AgentRunHandle, AgentRunOptions, AgentRunResult, AgentRunner } from './base.js';
import type { RunnerConfig } from './config.js';

// The `cloud` runner dispatches a run to the managed runner service. The real
// client adapter (`CloudAgentRunner`) ships from the private `cloud/adapter`
// (gitignored), loaded lazily at run time and gated by `PITCHBOX_EDITION=cloud`,
// so OSS clones - where the adapter is absent - build and run unchanged. Without
// the edition flag, a valid `PITCHBOX_RUNNER_URL`, and the adapter present, a
// run fails with an actionable message (the dispatch path marks it failed).

export interface CloudAdapterModule {
  CloudAgentRunner: new (cfg: { url: string; token?: string; backend?: string }) => AgentRunner;
}

export class CloudRunner implements AgentRunner {
  readonly slug = 'cloud';
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config?: RunnerConfig) {}

  run(opts: AgentRunOptions): AgentRunHandle {
    let cancelFn: () => void = () => {};
    const result: Promise<AgentRunResult> = (async () => {
      const adapter = await loadCloudAdapter();
      const handle = adapter.run(opts);
      cancelFn = handle.cancel;
      return handle.result;
    })();
    return { result, cancel: () => cancelFn() };
  }
}

// Back-compat alias: earlier code referred to the throwing stub by this name.
export { CloudRunner as CloudRunnerStub };

/** True when the cloud edition is enabled and a runner URL is configured. */
export function isCloudRunnerEnabled(): boolean {
  return process.env.PITCHBOX_EDITION === 'cloud' && !!process.env.PITCHBOX_RUNNER_URL;
}

async function importCloudAdapter(): Promise<CloudAdapterModule> {
  // The web (Vite) resolves this via an alias and bundles it (see web/vite.config.ts);
  // tsx/dev contexts fall back to the path under the umbrella. Both throw in an OSS
  // clone where the private adapter is absent - the caller surfaces an actionable error.
  try {
    // @ts-expect-error optional private module, resolved at run time (Vite alias in the web, path fallback in tsx).
    return (await import('@pitchbox/cloud-adapter')) as CloudAdapterModule;
  } catch (primaryErr) {
    try {
      const spec = ['..', '..', '..', 'cloud', 'adapter', 'src', 'index.js'].join('/');
      return (await import(spec)) as CloudAdapterModule;
    } catch {
      // The path fallback only applies to the unbundled tsx case; in a bundled
      // build it never resolves. Surface the primary error - it's the real cause.
      throw primaryErr;
    }
  }
}

async function loadCloudAdapter(): Promise<AgentRunner> {
  if (process.env.PITCHBOX_EDITION !== 'cloud') {
    throw new Error('Cloud runner requires PITCHBOX_EDITION=cloud.');
  }
  const url = process.env.PITCHBOX_RUNNER_URL;
  if (!url) throw new Error('Cloud runner: PITCHBOX_RUNNER_URL is not set.');

  let mod: CloudAdapterModule;
  try {
    mod = await importCloudAdapter();
  } catch (err) {
    throw new Error(
      'Cloud adapter not available - clone the private cloud/adapter into this umbrella (see docs/cloud-runner.md). ' +
        String(err instanceof Error ? err.message : err),
      { cause: err },
    );
  }
  return new mod.CloudAgentRunner({
    url,
    token: process.env.PITCHBOX_RUNNER_TOKEN,
    backend: process.env.PITCHBOX_RUNNER_BACKEND,
  });
}
