/**
 * Central registry for domain-status badges.
 *
 * Every status that appears as a coloured pill in the UI is defined here so
 * the look stays identical everywhere it shows up. Tones follow a single
 * semantic palette - hue maps to meaning, not to a specific value:
 *
 *   amber   - needs user attention        (pending_review, cancelled)
 *   sky     - in progress, in flight      (approved, running, queued-in-progress)
 *   emerald - delivered / completed ok    (sent, success, active)
 *   violet  - positive outcome / reward   (replied)
 *   rose    - rejected / failed           (rejected, failed)
 *   slate   - idle, disabled              (queued, paused)
 *   orange  - platform / category accent  (subreddit, reddit, post_comment)
 *
 * Pulsing is reserved for *transient* states (running). Always-on states like
 * "active" or "sent" stay static so the UI doesn't throb.
 */

import { t, type Locale } from '$lib/i18n/index.js';

export type Tone =
  'neutral' | 'muted' | 'emerald' | 'sky' | 'amber' | 'rose' | 'violet' | 'slate' | 'orange';

export type BadgeStyle = {
  tone: Tone;
  /** When true, adds a pulsing left dot (used for "running" / "active"). */
  pulse?: boolean;
};

/**
 * Tailwind classes per tone. Each tone pairs a darker text colour for light
 * mode with the lighter shade for dark mode, so badges remain readable on
 * both backgrounds.
 */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-foreground/10 text-foreground/80 ring-foreground/15',
  muted: 'bg-muted text-muted-foreground ring-border/50',
  emerald:
    'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300 dark:ring-emerald-500/25',
  sky: 'bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300 dark:ring-sky-500/25',
  amber:
    'bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300 dark:ring-amber-500/25',
  rose: 'bg-rose-500/15 text-rose-700 ring-rose-500/35 dark:text-rose-300 dark:ring-rose-500/30',
  violet:
    'bg-violet-500/15 text-violet-700 ring-violet-500/30 dark:text-violet-300 dark:ring-violet-500/25',
  slate:
    'bg-slate-500/15 text-slate-700 ring-slate-500/30 dark:text-slate-300 dark:ring-slate-500/25',
  orange:
    'bg-orange-500/15 text-orange-700 ring-orange-500/30 dark:text-orange-300 dark:ring-orange-500/25',
};

export const PULSE_DOT_CLASS: Record<Tone, string> = {
  neutral: 'bg-foreground/50',
  muted: 'bg-muted-foreground/70',
  emerald: 'bg-emerald-400',
  sky: 'bg-sky-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-400',
  violet: 'bg-violet-400',
  slate: 'bg-slate-400',
  orange: 'bg-orange-400',
};

/**
 * Bare text colour per tone, no background or ring. For icons, inline value
 * labels, and anything that needs the semantic hue but can't render the full
 * pill (StatusBadge already covers the pill case). Same hue and shade as
 * TONE_CLASS's text portion, so a tone reads identically whether it shows up
 * as a badge, an icon, or a line of text.
 */
export const TONE_TEXT_CLASS: Record<Tone, string> = {
  neutral: 'text-foreground/80',
  muted: 'text-muted-foreground',
  emerald: 'text-emerald-700 dark:text-emerald-300',
  sky: 'text-sky-700 dark:text-sky-300',
  amber: 'text-amber-700 dark:text-amber-300',
  rose: 'text-rose-700 dark:text-rose-300',
  violet: 'text-violet-700 dark:text-violet-300',
  slate: 'text-slate-700 dark:text-slate-300',
  orange: 'text-orange-700 dark:text-orange-300',
};

/**
 * Border + tinted background + text per tone, for inline warning/info/error
 * banners (a full card, not a small pill). Same palette as TONE_CLASS, just
 * a `border` recipe instead of a `ring` one since banners sit inline in the
 * page rather than next to text.
 */
export const TONE_BANNER_CLASS: Record<Tone, string> = {
  neutral: 'border-border bg-muted/40 text-foreground',
  muted: 'border-border bg-muted/40 text-muted-foreground',
  emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  sky: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  rose: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  violet: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  slate: 'border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-300',
  orange: 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300',
};

// ---------------------------------------------------------------------------
// Per-domain maps
// ---------------------------------------------------------------------------

// Kind badges classify content; they don't carry state, so keep hues subtle
// enough not to compete with the state colours below.
//
// Six kinds reach this map. The first four are outbound drafts an agent
// composes; `reply_dm` and `reply_comment` are the continuations the reply
// drafter enqueues when an inbound message lands (see shared/src/reply-drafter.ts).
// Miss one and resolveBadge falls through to `{ label: value }`, which prints
// the raw enum in the UI, so keep this in step with `ReplyKind` and `DraftKind`.
export const DRAFT_KIND: Record<string, BadgeStyle> = {
  dm: { tone: 'sky' },
  post: { tone: 'violet' },
  post_comment: { tone: 'orange' },
  comment_reply: { tone: 'slate' },
  reply_dm: { tone: 'sky' },
  reply_comment: { tone: 'slate' },
};

// The draft lifecycle: pending (amber) → approved (sky) → sent (emerald) ↗ replied (violet)
// rejected (rose) branches off at any point.
export const DRAFT_STATE: Record<string, BadgeStyle> = {
  pending_review: { tone: 'amber' },
  approved: { tone: 'sky' },
  sent: { tone: 'emerald' },
  replied: { tone: 'violet' },
  rejected: { tone: 'rose' },
  // Issue #335: the platform refused delivery, not the human - terminal like
  // rejected/sent, but slate rather than rose since nothing went wrong.
  undeliverable: { tone: 'slate' },
};

// A run lifecycle mirrors draft state: queued/running → success (emerald) or
// failed (rose). Cancelled is amber (user intervention, not an error).
export const RUN_STATUS: Record<string, BadgeStyle> = {
  queued: { tone: 'slate' },
  running: { tone: 'sky', pulse: true },
  success: { tone: 'emerald' },
  failed: { tone: 'rose' },
  cancelled: { tone: 'amber' },
};

export const CAMPAIGN_STATUS: Record<string, BadgeStyle> = {
  active: { tone: 'emerald' },
  paused: { tone: 'slate' },
  safety_braked: { tone: 'rose' },
};

// A keyword watch is active by default; pausing it (isActive: false) is a
// deliberate user action, and "backing off" means the daemon's fetch loop
// has hit its consecutive-failure threshold for r/{subreddit}/new.json and
// is spacing out retries (`keyword_watches.next_attempt_after` is set).
export const KEYWORD_WATCH_STATUS: Record<string, BadgeStyle> = {
  active: { tone: 'emerald' },
  paused: { tone: 'slate' },
  backing_off: { tone: 'amber' },
};

// Contact history per-row status - `replied` gets its own violet so it stands
// out from merely "sent" (the ultimate goal, not just delivery).
export const CONTACT_STATUS: Record<string, BadgeStyle> = {
  replied: { tone: 'violet' },
  no_reply: { tone: 'muted' },
  unchecked: { tone: 'muted' },
};

export const BLOCKLIST_KIND: Record<string, BadgeStyle> = {
  subreddit: { tone: 'orange' },
  user: { tone: 'sky' },
  keyword: { tone: 'slate' },
};

export const PLATFORM: Record<string, BadgeStyle> = {
  reddit: { tone: 'orange' },
};

export const DAEMON_STATUS: Record<string, BadgeStyle> = {
  online: { tone: 'emerald' },
  offline: { tone: 'slate' },
  checking: { tone: 'muted' },
  // The status poll itself could not be read (a lapsed session, a 5xx, a
  // dropped connection). That is not evidence the daemon is down.
  unknown: { tone: 'muted' },
};

// The 8 timeline event kinds in the run log (runlog/EventRow.svelte and
// siblings). A kind, not a status - it never changes once an event lands -
// so tones are chosen to echo the concept elsewhere in the registry (e.g.
// tool calls share the same sky as an in-flight run).
export const EVENT_KIND: Record<string, BadgeStyle> = {
  session: { tone: 'violet' },
  thinking: { tone: 'slate' },
  'tool-call': { tone: 'sky' },
  'tool-result': { tone: 'emerald' },
  assistant: { tone: 'sky' },
  'rate-limit': { tone: 'amber' },
  unknown: { tone: 'slate' },
};

// Per-tool-call status inside a run log entry (ToolCallEvent.svelte), derived
// client-side from whether a paired result has arrived yet and whether it
// errored.
export const TOOL_CALL_STATUS: Record<string, BadgeStyle> = {
  pending: { tone: 'amber', pulse: true },
  ok: { tone: 'emerald' },
  error: { tone: 'rose' },
};

// Realtime connection health (daemon reachability, SSE stream), shared by
// SystemStatusCard and SseIndicator so both read the same four-state palette
// instead of each re-deriving it.
export const CONNECTION_STATUS: Record<string, BadgeStyle> = {
  live: { tone: 'emerald', pulse: true },
  warn: { tone: 'amber', pulse: true },
  down: { tone: 'rose' },
  idle: { tone: 'muted' },
};

// RunLog's live SSE status text uses capitalised words, distinct casing from
// the DB-driven `runs.status` column that RUN_STATUS above models, but the
// same lifecycle and the same tones.
export const RUN_LIVE_STATUS: Record<string, BadgeStyle> = {
  Idle: { tone: 'slate' },
  Running: { tone: 'sky', pulse: true },
  Finished: { tone: 'emerald' },
  Failed: { tone: 'rose' },
  Cancelled: { tone: 'amber' },
};

// Outgoing webhook delivery attempts (settings > notifications).
export const WEBHOOK_DELIVERY_STATUS: Record<string, BadgeStyle> = {
  pending: { tone: 'amber' },
  delivered: { tone: 'emerald' },
  dead: { tone: 'rose' },
};

// Generic alert/banner severity. `info` stays neutral (no colour) to match
// plain body text; only success/warning/error get a hue.
export const ALERT_SEVERITY: Record<string, BadgeStyle> = {
  info: { tone: 'neutral' },
  success: { tone: 'emerald' },
  warning: { tone: 'amber' },
  error: { tone: 'rose' },
};

// A project source's own fetch state (#432, ProjectSourcesPanel.svelte):
// 'synced' after a successful re-fetch, 'failed' when the last attempt set
// fetch_error (including an unimplemented kind - see project-source-sync.ts),
// 'pending' before it has ever been fetched.
export const PROJECT_SOURCE_STATUS: Record<string, BadgeStyle> = {
  synced: { tone: 'emerald' },
  failed: { tone: 'rose' },
  pending: { tone: 'muted' },
};

export type BadgeDomain =
  | 'draft-kind'
  | 'draft-state'
  | 'run-status'
  | 'campaign-status'
  | 'contact-status'
  | 'blocklist-kind'
  | 'platform'
  | 'daemon-status'
  | 'event-kind'
  | 'tool-call-status'
  | 'connection-status'
  | 'run-live-status'
  | 'webhook-delivery-status'
  | 'alert-severity'
  | 'keyword-watch-status'
  | 'project-source-status';

export const BADGE_DOMAIN: Record<BadgeDomain, Record<string, BadgeStyle>> = {
  'draft-kind': DRAFT_KIND,
  'draft-state': DRAFT_STATE,
  'run-status': RUN_STATUS,
  'campaign-status': CAMPAIGN_STATUS,
  'contact-status': CONTACT_STATUS,
  'blocklist-kind': BLOCKLIST_KIND,
  platform: PLATFORM,
  'daemon-status': DAEMON_STATUS,
  'event-kind': EVENT_KIND,
  'tool-call-status': TOOL_CALL_STATUS,
  'connection-status': CONNECTION_STATUS,
  'run-live-status': RUN_LIVE_STATUS,
  'webhook-delivery-status': WEBHOOK_DELIVERY_STATUS,
  'alert-severity': ALERT_SEVERITY,
  'keyword-watch-status': KEYWORD_WATCH_STATUS,
  'project-source-status': PROJECT_SOURCE_STATUS,
};

/** Fallback for an unknown value - neutral styling, no label opinion. */
export function resolveBadge(domain: BadgeDomain, value: string): BadgeStyle {
  return BADGE_DOMAIN[domain]?.[value] ?? { tone: 'muted' };
}

/**
 * The localized label for a domain/value pair (LOR-263: `badge.<domain>.<value>`
 * in the dashboard catalogue). A value with no entry in `BADGE_DOMAIN` - an
 * enum this registry hasn't caught up with yet - passes the raw identifier
 * through rather than a translated guess, the same fallback `resolveBadge`
 * already used for its tone.
 */
export function badgeLabel(
  locale: Locale | null | undefined,
  domain: BadgeDomain,
  value: string,
): string {
  if (!BADGE_DOMAIN[domain]?.[value]) return value;
  return t(locale, `badge.${domain}.${value}`);
}

/** Resolve just the tone for a domain/value pair, for callers that need the
 * semantic colour but can't render the pill (icon fill, border, custom badge
 * shape). Prefer this over hardcoding a Tailwind colour class. */
export function resolveTone(domain: BadgeDomain, value: string): Tone {
  return resolveBadge(domain, value).tone;
}
