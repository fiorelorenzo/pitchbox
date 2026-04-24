import pkg from '../../../package.json';

/** Single source of truth: web/package.json "version". Prefix with `v` for display. */
export const VERSION = `v${pkg.version}`;
