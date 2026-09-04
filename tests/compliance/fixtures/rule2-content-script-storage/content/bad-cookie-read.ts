// Fixture for linkedin-boundary.test.ts (#308, rule 2). Registered as a
// LinkedIn content script by the sibling manifest.config.ts. Deliberately
// violates the compliance boundary. Inert - never bundled by the real build.
export function readSession(): string {
  return document.cookie;
}
