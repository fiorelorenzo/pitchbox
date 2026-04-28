export type QuotaKind = 'dm' | 'comment' | 'post';
export const QUOTA_KINDS: QuotaKind[] = ['dm', 'comment', 'post'];

export const DRAFT_KINDS = ['dm', 'post', 'post_comment', 'comment_reply'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export function isDraftKind(s: string): s is DraftKind {
  return (DRAFT_KINDS as readonly string[]).includes(s);
}

export type WindowCounts = { day: number; week: number };
export type UsageByKind = Record<QuotaKind, WindowCounts>;

export type QuotaLimits = Record<QuotaKind, { perDay: number; perWeek: number }>;

export function emptyUsage(): UsageByKind {
  return {
    dm: { day: 0, week: 0 },
    comment: { day: 0, week: 0 },
    post: { day: 0, week: 0 },
  };
}

export function mapDraftKindToQuotaKind(draftKind: DraftKind): QuotaKind {
  switch (draftKind) {
    case 'dm':
      return 'dm';
    case 'post':
      return 'post';
    case 'post_comment':
    case 'comment_reply':
      return 'comment';
    default: {
      const _exhaustive: never = draftKind;
      return _exhaustive;
    }
  }
}

export function isOverQuota(
  usage: WindowCounts,
  limit: { perDay: number; perWeek: number },
): { overDay: boolean; overWeek: boolean } {
  return { overDay: usage.day >= limit.perDay, overWeek: usage.week >= limit.perWeek };
}

// Platform-agnostic safe defaults used when `app_config['quota_defaults']` is
// missing the requested platform key. Today only Reddit is in use; the
// fallback values match the Reddit defaults seeded by seed-core.
export const QUOTA_LIMITS_FALLBACK: QuotaLimits = {
  dm: { perDay: 10, perWeek: 50 },
  comment: { perDay: 50, perWeek: 200 },
  post: { perDay: 5, perWeek: 20 },
};
