// Fixture manifest for linkedin-boundary.test.ts (#308, rule 2). Mirrors
// #348's real shape: content_scripts stays empty because the LinkedIn
// content script is registered at runtime instead (see src/background.ts),
// not declared statically. Inert - never referenced by the real build.
export default {
  content_scripts: [],
  host_permissions: [],
};
