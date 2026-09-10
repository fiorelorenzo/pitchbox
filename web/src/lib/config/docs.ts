import { dev } from '$app/environment';

/**
 * The documentation site, in one place.
 *
 * D38 (`docs/design/DECISIONS.md`) moved the site to its own host, so there is
 * no path prefix any more: production is `https://docs.pitchbox.app/` and the
 * local VitePress dev/preview server serves the same root base on :5181. Both
 * halves of the old literal (`.../pitchbox/`) went stale in that move and
 * nothing noticed, because the value was pasted into two components (LOR-209).
 *
 * The trailing slash is part of the value: callers concatenate a page path
 * onto it (`${DOCS_URL}auth`).
 */
export const DOCS_URL = dev ? 'http://localhost:5181/' : 'https://docs.pitchbox.app/';
