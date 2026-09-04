// Fixture manifest for linkedin-boundary.test.ts (#308, rule 2). Mirrors the
// shape of extension/manifest.config.ts's default export closely enough for
// linkedinContentScriptFiles() to derive the content-script set from it.
// Inert - never referenced by the real extension build.
export default {
  content_scripts: [
    {
      matches: ['https://www.linkedin.com/*'],
      js: ['content/bad-cookie-read.ts'],
    },
  ],
  host_permissions: [],
};
