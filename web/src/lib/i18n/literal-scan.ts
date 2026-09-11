/**
 * LOR-263's guard against this class of defect coming back: a scan for
 * user-visible English literals left in `.svelte` markup instead of routed
 * through `t()`/`tn()`/`badgeLabel()`.
 *
 * What it catches: a plain-text HTML node (`>Some words<`) or a bare
 * double-quoted `title`/`placeholder`/`aria-label`/`alt`/`description`
 * attribute value, anywhere outside a `<script>` block or an HTML comment,
 * that contains a run of two or more letters. That is deliberately narrow:
 * it is exactly the two places real UI copy in this codebase's Svelte 5
 * components lives, once `class`/`style`/event-handler code is out of the
 * way, and it costs nothing to check.
 *
 * What it cannot catch, on purpose - a full HTML+JS parser would still miss
 * some of these, and chasing them is how a scan earns a 200-line allowlist
 * that proves nothing:
 * - A string built at runtime (`` `Open ${label}` `` inside an expression,
 *   `condition ? 'a' : 'b'`) - anything inside `{...}` is skipped outright,
 *   since that is also where every legitimate non-visible identifier
 *   (a `domain="draft-kind"` prop, a CSS class picked by a ternary) lives.
 *   This is the real gap: a hardcoded English string passed as a prop value
 *   through an expression slips through. Every conversion in this PR was
 *   done by reading the diff by hand for exactly that reason - the scan is
 *   the regression gate, not the first line of defence.
 * - Any attribute other than the five listed (`label`, `text`, a custom
 *   component prop) - widening the attribute list is easy to do later and
 *   deliberately not done here until a real miss shows it is needed.
 * - Markdown/HTML rendered from a database column (draft bodies, playbook
 *   content) - that is user or agent-authored content, never catalogue copy.
 */

const SCRIPT_BLOCK_RE = /<script[\s\S]*?<\/script>/g;
const STYLE_BLOCK_RE = /<style[\s\S]*?<\/style>/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** A bare (non-`{...}`) string in one of these attributes is user-visible chrome. */
const SCANNED_ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'description'];

const TEXT_NODE_RE = />([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g;
const ATTR_RE = new RegExp(
  `\\b(?:${SCANNED_ATTRS.join('|')})="([^"{}]*[A-Za-z]{2,}[^"{}]*)"`,
  'g',
);

export type Literal = { kind: 'text' | 'attr'; value: string };

/** Scans one file's already-read source for candidate English literals. */
export function scanSource(source: string): Literal[] {
  const stripped = source
    .replace(SCRIPT_BLOCK_RE, '')
    .replace(STYLE_BLOCK_RE, '')
    .replace(COMMENT_RE, '');
  const hits: Literal[] = [];
  for (const m of stripped.matchAll(TEXT_NODE_RE)) {
    const value = m[1].trim();
    if (value) hits.push({ kind: 'text', value });
  }
  for (const m of stripped.matchAll(ATTR_RE)) {
    const value = m[1].trim();
    if (value) hits.push({ kind: 'attr', value });
  }
  return hits;
}

/**
 * Route trees and shared components already converted under LOR-263, in
 * whichever PR: this scan covers exactly these, not `routes/**` and
 * `components/**` wholesale. Three siblings are converting the rest of the
 * dashboard in parallel right now (campaigns, projects, companion, most of
 * settings) - scanning their in-flight surfaces would fail on work that is
 * simply not done yet, not on a regression, and a scan that fails on
 * business as usual gets deleted. Extend this list as each surface lands;
 * `web/tests/i18n-literal-scan.test.ts` re-derives the file list from it on
 * every run, so there is nothing else to keep in sync.
 */
export const SCAN_ROUTE_DIRS = [
  'routes/login',
  'routes/register',
  'routes/invite',
  'routes/reset',
  'routes/onboarding',
  'routes/settings/onboarding',
  'routes/inbox',
  'routes/people',
  'routes/conversations',
  'routes/blocklist',
  'routes/playbooks',
  'routes/notifications',
  'routes/analytics',
  'routes/audit',
  'routes/verify',
];

export const SCAN_ROUTE_FILES = ['routes/+layout.svelte'];

/**
 * `lib/components/ui/**` (the shadcn primitives) is nobody's per LOR-263's
 * area split and is never scanned. Everything else here is listed
 * individually rather than swept as `lib/components/**`: several other
 * components in that directory (DraftDetail, RunLog, the settings cards,
 * ...) belong to a surface still being converted and genuinely still carry
 * English copy - that is unfinished work, not a regression, and does not
 * belong in this scan yet.
 */
export const SCAN_COMPONENT_FILES = [
  'lib/components/BillingGraceBanner.svelte',
  'lib/components/ChatSyncStalledBanner.svelte',
  'lib/components/DraftListItem.svelte',
  'lib/components/EmptyState.svelte',
  'lib/components/ExtensionDeviceNudgeBanner.svelte',
  'lib/components/OnboardingBanner.svelte',
  'lib/components/OrgSwitcher.svelte',
  'lib/components/PageContainer.svelte',
  'lib/components/PageHeader.svelte',
  'lib/components/Seo.svelte',
  'lib/components/Sidebar.svelte',
  'lib/components/StatusBadge.svelte',
];

/**
 * Per-file exceptions, checked by exact trimmed literal text. Every entry
 * earns its place with a reason - the moment this needs a reason like "too
 * annoying to fix", the scan has stopped being a gate:
 * - A domain/product name a reader would never see rendered differently in
 *   Italian (a URL's own host, an example company name in a placeholder).
 * - One named, dated exception for a real gap on somebody else's surface
 *   (LOR-263 part one's own `/inbox`), which this PR does not fix because
 *   `/inbox` is not one of the eight route trees it owns - removing the
 *   allowlist entry is the reminder to go fix it.
 */
export const ALLOWLIST: Record<string, string[]> = {
  'lib/components/ChatSyncStalledBanner.svelte': [
    'reddit.com', // the literal link text for https://www.reddit.com/, not prose
  ],
  'lib/components/OrgSwitcher.svelte': [
    'Acme Inc.', // example org name in the "create organization" placeholder
  ],
  'routes/inbox/+page.svelte': [
    // TODO(LOR-263): web/src/routes/inbox/+page.svelte's "Load more" retry
    // button (~line 837) was never wired to the `inbox.retry` key that
    // already exists in the catalogue - a pre-existing gap from part one,
    // out of scope here since /inbox isn't one of this PR's eight routes.
    'Retry',
  ],
};
