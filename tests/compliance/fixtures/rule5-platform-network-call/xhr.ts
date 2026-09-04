// Fixture for linkedin-boundary.test.ts (#308, rule 5). Covers the
// XMLHttpRequest branch of checkLinkedinPlatformNetworkCalls specifically -
// this branch was dead code until the fix landed alongside this fixture.
// Inert - never imported by real code.
export function makeRequest(): XMLHttpRequest {
  return new XMLHttpRequest();
}
