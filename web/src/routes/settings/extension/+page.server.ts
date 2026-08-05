import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const role = event.locals.org?.role;
  const isAdmin = !role || role === 'admin' || role === 'owner';

  return {
    extension: {
      // What the user should point the extension at: an explicit override if
      // set, otherwise this dashboard's own public origin (which is exactly
      // the backend the extension auto-pairs against and what you type into
      // its "Add connection" form). See docs/extension-connection-design.md.
      // Not privileged (it's just this instance's own URL), so visible to
      // every member; only minting a pairing code (POST
      // /api/settings/extension-pairing) is admin-gated (see
      // ExtensionDevices.svelte, driven by `isAdmin` below). This loader
      // used to be part of the General page's Integrations tab (#254 split
      // it into its own route, renamed to "Browser extension").
      backendUrl: process.env.PITCHBOX_BACKEND_URL ?? event.url.origin,
    },
    isAdmin,
  };
};
