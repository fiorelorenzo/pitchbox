// Fixture manifest for linkedin-boundary.test.ts (#308, rule 2, dynamic path).
// Deliberately declares NO LinkedIn content script: the script is registered at
// runtime instead, which is how the real extension does it (#317 keeps the
// LinkedIn grant optional, and a declared content script is an install-time
// grant). Inert - never referenced by the real extension build.
export default {
  content_scripts: [],
  host_permissions: [],
};
