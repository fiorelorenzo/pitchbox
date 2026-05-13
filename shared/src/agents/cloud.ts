import type { AgentRunHandle, AgentRunOptions, AgentRunner } from './base.js';
import type { RunnerConfig } from './config.js';

// Stub `cloud` runner. The real implementation dispatches runs to a managed
// backend and lives in the private `cloud/` submodule (see docs/auth.md for
// the repo-strategy section). On the OSS build the stub stays — registered
// but throws if instantiated — so the dashboard can show the runner in the
// detection table and gate selection behind the `cloud` edition.

export class CloudRunnerStub implements AgentRunner {
  readonly slug = 'cloud';
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config?: RunnerConfig) {
    throw new Error(
      "Cloud runner adapter is not available in this build. Configure the private 'cloud/' submodule and run with PITCHBOX_EDITION=cloud.",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  run(_opts: AgentRunOptions): AgentRunHandle {
    throw new Error('Cloud runner unavailable.');
  }
}
