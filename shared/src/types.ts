export type DraftState =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'sent'
  | 'not_sent'
  | 'replied'
  | 'dead';

export type DraftKind = 'dm' | 'post' | 'post_comment' | 'comment_reply';

export type RunTrigger = 'cron' | 'manual' | 'api';

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export type CampaignStatus = 'active' | 'paused' | 'safety_braked';

export type AccountRole = 'brand' | 'personal' | 'other';
