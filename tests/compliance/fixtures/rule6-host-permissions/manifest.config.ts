// Fixture manifest for linkedin-boundary.test.ts (#308, rule 6). Simulates a
// later change that quietly promotes LinkedIn from an optional, on-demand
// grant (#317) to a blanket host_permissions entry. Inert.
export default {
  content_scripts: [],
  host_permissions: ['https://www.reddit.com/*', 'https://www.linkedin.com/*'],
};
