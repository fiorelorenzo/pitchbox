/**
 * Central registry for domain-status badges.
 *
 * Every status that appears as a coloured pill in the UI is defined here so
 * the look stays identical everywhere it shows up. Tones follow a single
 * semantic palette — hue maps to meaning, not to a specific value:
 *
 *   amber   — needs user attention        (pending_review, cancelled)
 *   sky     — in progress, in flight      (approved, running, queued-in-progress)
 *   emerald — delivered / completed ok    (sent, success, active)
 *   violet  — positive outcome / reward   (replied)
 *   rose    — rejected / failed           (rejected, failed)
 *   slate   — idle, disabled              (queued, paused)
 *   orange  — platform / category accent  (subreddit, reddit, post_comment)
 *
 * Pulsing is reserved for *transient* states (running). Always-on states like
 * "active" or "sent" stay static so the UI doesn't throb.
 */

type Tone =
  | 'neutral'
  | 'muted'
  | 'emerald'
  | 'sky'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'slate'
  | 'orange';

export type BadgeStyle = {
  label: string;
  tone: Tone;
  /** When true, adds a pulsing left dot (used for "running" / "active"). */
  pulse?: boolean;
};

/** Tailwind classes per tone. Tuned for the app's dark-first theme. */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-foreground/10 text-foreground/80 ring-foreground/15',
  muted: 'bg-muted text-muted-foreground ring-border/50',
  emerald: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/25',
  sky: 'bg-sky-500/15 text-sky-300 ring-sky-500/25',
  amber: 'bg-amber-500/15 text-amber-300 ring-amber-500/25',
  rose: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  violet: 'bg-violet-500/15 text-violet-300 ring-violet-500/25',
  slate: 'bg-slate-500/15 text-slate-300 ring-slate-500/25',
  orange: 'bg-orange-500/15 text-orange-300 ring-orange-500/25',
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

// Contact history per-row status — `replied` gets its own violet so it stands
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

export type BadgeDomain =
  | 'draft-kind'
  | 'draft-state'
  | 'run-status'
  | 'campaign-status'
  | 'contact-status'
  | 'blocklist-kind'
  | 'platform'
  | 'daemon-status';

export const BADGE_DOMAIN: Record<BadgeDomain, Record<string, BadgeStyle>> = {
  'draft-kind': DRAFT_KIND,
  'draft-state': DRAFT_STATE,
  'run-status': RUN_STATUS,
  'campaign-status': CAMPAIGN_STATUS,
  'contact-status': CONTACT_STATUS,
  'blocklist-kind': BLOCKLIST_KIND,
  platform: PLATFORM,
  'daemon-status': DAEMON_STATUS,
};

/** Fallback for an unknown value — the raw string with neutral styling. */
export function resolveBadge(domain: BadgeDomain, value: string): BadgeStyle {
  return BADGE_DOMAIN[domain]?.[value] ?? { label: value, tone: 'muted' };
}
