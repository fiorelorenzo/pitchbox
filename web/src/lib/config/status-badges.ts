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

export type Tone =
  'neutral' | 'muted' | 'emerald' | 'sky' | 'amber' | 'rose' | 'violet' | 'slate' | 'orange';

export type BadgeStyle = {
  label: string;
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
export const DRAFT_KIND: Record<string, BadgeStyle> = {
  dm: { label: 'DM', tone: 'sky' },
  post: { label: 'Post', tone: 'violet' },
  post_comment: { label: 'Comment', tone: 'orange' },
  comment_reply: { label: 'Reply', tone: 'slate' },
};

// The draft lifecycle: pending (amber) → approved (sky) → sent (emerald) ↗ replied (violet)
// rejected (rose) branches off at any point.
export const DRAFT_STATE: Record<string, BadgeStyle> = {
  pending_review: { label: 'Pending', tone: 'amber' },
  approved: { label: 'Approved', tone: 'sky' },
  sent: { label: 'Sent', tone: 'emerald' },
  replied: { label: 'Replied', tone: 'violet' },
  rejected: { label: 'Rejected', tone: 'rose' },
};

// A run lifecycle mirrors draft state: queued/running → success (emerald) or
// failed (rose). Cancelled is amber (user intervention, not an error).
export const RUN_STATUS: Record<string, BadgeStyle> = {
  queued: { label: 'Queued', tone: 'slate' },
  running: { label: 'Running', tone: 'sky', pulse: true },
  success: { label: 'Success', tone: 'emerald' },
  failed: { label: 'Failed', tone: 'rose' },
  cancelled: { label: 'Cancelled', tone: 'amber' },
};

export const CAMPAIGN_STATUS: Record<string, BadgeStyle> = {
  active: { label: 'Active', tone: 'emerald' },
  paused: { label: 'Paused', tone: 'slate' },
  safety_braked: { label: 'Safety brake', tone: 'rose' },
};

// A keyword watch is active by default; pausing it (isActive: false) is a
// deliberate user action, and "backing off" means the daemon's fetch loop
// has hit its consecutive-failure threshold for r/{subreddit}/new.json and
// is spacing out retries (`keyword_watches.next_attempt_after` is set).
export const KEYWORD_WATCH_STATUS: Record<string, BadgeStyle> = {
  active: { label: 'Active', tone: 'emerald' },
  paused: { label: 'Paused', tone: 'slate' },
  backing_off: { label: 'Backing off', tone: 'amber' },
};

// Contact history per-row status - `replied` gets its own violet so it stands
// out from merely "sent" (the ultimate goal, not just delivery).
export const CONTACT_STATUS: Record<string, BadgeStyle> = {
  replied: { label: 'Replied', tone: 'violet' },
  no_reply: { label: 'No reply yet', tone: 'muted' },
  unchecked: { label: 'Unchecked', tone: 'muted' },
};

export const BLOCKLIST_KIND: Record<string, BadgeStyle> = {
  subreddit: { label: 'Subreddit', tone: 'orange' },
  user: { label: 'User', tone: 'sky' },
  keyword: { label: 'Keyword', tone: 'slate' },
};

export const PLATFORM: Record<string, BadgeStyle> = {
  reddit: { label: 'Reddit', tone: 'orange' },
};

export const DAEMON_STATUS: Record<string, BadgeStyle> = {
  online: { label: 'Online', tone: 'emerald' },
  offline: { label: 'Offline', tone: 'slate' },
  checking: { label: 'Checking…', tone: 'muted' },
};

// The 8 timeline event kinds in the run log (runlog/EventRow.svelte and
// siblings). A kind, not a status - it never changes once an event lands -
// so tones are chosen to echo the concept elsewhere in the registry (e.g.
// tool calls share the same sky as an in-flight run).
export const EVENT_KIND: Record<string, BadgeStyle> = {
  session: { label: 'Session', tone: 'violet' },
  thinking: { label: 'Thinking', tone: 'slate' },
  'tool-call': { label: 'Tool call', tone: 'sky' },
  'tool-result': { label: 'Tool result', tone: 'emerald' },
  assistant: { label: 'Assistant', tone: 'sky' },
  'rate-limit': { label: 'Rate limit', tone: 'amber' },
  unknown: { label: 'Unknown', tone: 'slate' },
};

// Per-tool-call status inside a run log entry (ToolCallEvent.svelte), derived
// client-side from whether a paired result has arrived yet and whether it
// errored.
export const TOOL_CALL_STATUS: Record<string, BadgeStyle> = {
  pending: { label: 'Running', tone: 'amber', pulse: true },
  ok: { label: 'OK', tone: 'emerald' },
  error: { label: 'Error', tone: 'rose' },
};

// Realtime connection health (daemon reachability, SSE stream), shared by
// SystemStatusCard and SseIndicator so both read the same four-state palette
// instead of each re-deriving it.
export const CONNECTION_STATUS: Record<string, BadgeStyle> = {
  live: { label: 'Live', tone: 'emerald', pulse: true },
  warn: { label: 'Reconnecting', tone: 'amber', pulse: true },
  down: { label: 'Offline', tone: 'rose' },
  idle: { label: 'Connecting', tone: 'muted' },
};

// RunLog's live SSE status text uses capitalised words, distinct casing from
// the DB-driven `runs.status` column that RUN_STATUS above models, but the
// same lifecycle and the same tones.
export const RUN_LIVE_STATUS: Record<string, BadgeStyle> = {
  Idle: { label: 'Idle', tone: 'slate' },
  Running: { label: 'Running', tone: 'sky', pulse: true },
  Finished: { label: 'Finished', tone: 'emerald' },
  Failed: { label: 'Failed', tone: 'rose' },
  Cancelled: { label: 'Cancelled', tone: 'amber' },
};

// Outgoing webhook delivery attempts (settings > notifications).
export const WEBHOOK_DELIVERY_STATUS: Record<string, BadgeStyle> = {
  pending: { label: 'Pending', tone: 'amber' },
  delivered: { label: 'Delivered', tone: 'emerald' },
  dead: { label: 'Dead', tone: 'rose' },
};

// Generic alert/banner severity. `info` stays neutral (no colour) to match
// plain body text; only success/warning/error get a hue.
export const ALERT_SEVERITY: Record<string, BadgeStyle> = {
  info: { label: 'Info', tone: 'neutral' },
  success: { label: 'Success', tone: 'emerald' },
  warning: { label: 'Warning', tone: 'amber' },
  error: { label: 'Error', tone: 'rose' },
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
  | 'keyword-watch-status';

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
};

/** Fallback for an unknown value - the raw string with neutral styling. */
export function resolveBadge(domain: BadgeDomain, value: string): BadgeStyle {
  return BADGE_DOMAIN[domain]?.[value] ?? { label: value, tone: 'muted' };
}

/** Resolve just the tone for a domain/value pair, for callers that need the
 * semantic colour but can't render the pill (icon fill, border, custom badge
 * shape). Prefer this over hardcoding a Tailwind colour class. */
export function resolveTone(domain: BadgeDomain, value: string): Tone {
  return resolveBadge(domain, value).tone;
}
