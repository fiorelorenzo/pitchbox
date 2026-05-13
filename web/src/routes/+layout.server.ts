import type { LayoutServerLoad } from './$types';

/**
 * Root layout loader. Exposes server-wide flags every page may need (currently
 * just `authOn` so the Sidebar can show Sign in vs Sign out).
 */
export const load: LayoutServerLoad = () => {
  return {
    authOn: process.env.PITCHBOX_AUTH === 'on',
  };
};
