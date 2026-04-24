/**
 * Central registry for domain-status badges.
 *
 * Every status that appears as a coloured pill in the UI is defined here so the
 * look stays identical everywhere it shows up. Tones are drawn from a small
 * palette — one hue per semantic meaning, not one per value — so the eye can
 * pick out "things that need action" (amber) from "things that went well"
 * (emerald) or "things that failed" (destructive) at a glance.
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

export const DRAFT_KIND: Record<string, BadgeStyle> = {
  dm: { label: 'DM', tone: 'sky' },
  post: { label: 'Post', tone: 'violet' },
  post_comment: { label: 'Comment', tone: 'violet' },
  comment_reply: { label: 'Reply', tone: 'neutral' },
};

export const DRAFT_STATE: Record<string, BadgeStyle> = {
  pending_review: { label: 'Pending', tone: 'amber' },
  approved: { label: 'Approved', tone: 'sky' },
  sent: { label: 'Sent', tone: 'emerald' },
  rejected: { label: 'Rejected', tone: 'rose' },
};

export const RUN_STATUS: Record<string, BadgeStyle> = {
  queued: { label: 'Queued', tone: 'slate' },
  running: { label: 'Running', tone: 'sky', pulse: true },
  success: { label: 'Success', tone: 'emerald' },
  failed: { label: 'Failed', tone: 'rose' },
  cancelled: { label: 'Cancelled', tone: 'amber' },
};

export const CAMPAIGN_STATUS: Record<string, BadgeStyle> = {
  active: { label: 'Active', tone: 'emerald', pulse: true },
  paused: { label: 'Paused', tone: 'slate' },
};

export const BLOCKLIST_KIND: Record<string, BadgeStyle> = {
  subreddit: { label: 'Subreddit', tone: 'orange' },
  user: { label: 'User', tone: 'sky' },
  keyword: { label: 'Keyword', tone: 'neutral' },
};

export const PLATFORM: Record<string, BadgeStyle> = {
  reddit: { label: 'Reddit', tone: 'orange' },
};

export type BadgeDomain =
  | 'draft-kind'
  | 'draft-state'
  | 'run-status'
  | 'campaign-status'
  | 'blocklist-kind'
  | 'platform';

export const BADGE_DOMAIN: Record<BadgeDomain, Record<string, BadgeStyle>> = {
  'draft-kind': DRAFT_KIND,
  'draft-state': DRAFT_STATE,
  'run-status': RUN_STATUS,
  'campaign-status': CAMPAIGN_STATUS,
  'blocklist-kind': BLOCKLIST_KIND,
  platform: PLATFORM,
};

/** Fallback for an unknown value — the raw string with neutral styling. */
export function resolveBadge(domain: BadgeDomain, value: string): BadgeStyle {
  return BADGE_DOMAIN[domain]?.[value] ?? { label: value, tone: 'muted' };
}
