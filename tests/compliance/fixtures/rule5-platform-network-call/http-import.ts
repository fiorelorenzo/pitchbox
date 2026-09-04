// Fixture for linkedin-boundary.test.ts (#308, rule 5). Covers the
// node:http/node:https/undici import-detection branch of
// checkLinkedinPlatformNetworkCalls. Inert - never imported by real code.
import { request } from 'node:https';

export function ping(): void {
  request('https://example.com').end();
}
