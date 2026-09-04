// Fixture manifest for linkedin-boundary.test.ts (#308, rule 2 safety net):
// nothing registers the LinkedIn-looking script next door, statically or
// dynamically, so rule 2 would never scan it. Inert.
export default {
  content_scripts: [],
  host_permissions: [],
};
