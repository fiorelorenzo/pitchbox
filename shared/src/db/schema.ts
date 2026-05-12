import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  smallint,
  bigint,
  bigserial,
  uniqueIndex,
  index,
  customType,
  numeric,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const platforms = pgTable('platforms', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  enabled: boolean('enabled').notNull().default(true),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable('organizations', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePair: uniqueIndex('memberships_org_user_unique').on(t.organizationId, t.userId),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index('sessions_user_idx').on(t.userId),
  }),
);

export const authFailures = pgTable(
  'auth_failures',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Either the IP address or the submitted username — both buckets are
    // tracked together so the rate-limit check can look them up identically.
    identifier: text('identifier').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
    // 'login_attempt' for now; future kinds (e.g. extension pairing) can reuse
    // the same table.
    kind: text('kind').notNull().default('login_attempt'),
  },
  (t) => ({
    byIdentifier: index('auth_failures_identifier_idx').on(t.identifier, t.failedAt),
  }),
);

export const playbooks = pgTable('playbooks', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  body: text('body').notNull(),
  isBuiltin: boolean('is_builtin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  organizationId: integer('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  defaultAgentRunner: text('default_agent_runner').notNull().default('claude-code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  platformId: integer('platform_id')
    .notNull()
    .references(() => platforms.id),
  handle: text('handle').notNull(),
  displayName: text('display_name'),
  role: text('role').notNull().default('personal'),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  cookieSession: bytea('cookie_session'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Optional per-account overrides for outreach volume. When set, they apply
  // in addition to (and never exceed) the platform-wide quota_defaults.
  dailyLimit: integer('daily_limit'),
  weeklyLimit: integer('weekly_limit'),
});

export const campaigns = pgTable('campaigns', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  platformId: integer('platform_id')
    .notNull()
    .references(() => platforms.id),
  name: text('name').notNull(),
  skillSlug: text('skill_slug').notNull(),
  agentRunner: text('agent_runner').notNull().default('claude-code'),
  config: jsonb('config').notNull().default({}),
  cronExpression: text('cron_expression'),
  rateLimit: jsonb('rate_limit').notNull().default({}),
  status: text('status').notNull().default('active'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  // Exponential-backoff state for the daemon scheduler. `failureAttempts`
  // counts consecutive dispatch failures (reset to 0 on success), and
  // `nextAttemptAfter` overrides the cron tick whenever the campaign is in
  // backoff. After 10 consecutive failures the campaign is paused via
  // `pausedDueToFailures` and a `campaign.paused` notification is emitted.
  failureAttempts: integer('failure_attempts').notNull().default(0),
  nextAttemptAfter: timestamp('next_attempt_after', { withTimezone: true }),
  pausedDueToFailures: boolean('paused_due_to_failures').notNull().default(false),
});

export const campaignRecommendations = pgTable(
  'campaign_recommendations',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scenarioSlug: text('scenario_slug').notNull(),
    name: text('name').notNull(),
    objective: text('objective').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byProject: index('campaign_recommendations_project_idx').on(t.projectId, t.createdAt.desc()),
  }),
);

export const runs = pgTable(
  'runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull().default('campaign'), // 'campaign' | 'project_extraction'
    campaignId: integer('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    params: jsonb('params').notNull().default({}),
    agentRunner: text('agent_runner').notNull().default('claude-code'),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    stdoutLogPath: text('stdout_log_path'),
    tokensUsed: integer('tokens_used'),
    // Per-run token usage breakdown captured from the runner's `usage` block.
    // `tokensUsed` above remains the legacy aggregate (input+output) for back-compat;
    // the columns below are the detailed split used for cost computation.
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),
    // USD cost reported by the runner when available, otherwise computed
    // from the token columns above using the runner's price table.
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    playbookBody: text('playbook_body'),
    // Structured failure taxonomy; nullable for success/running rows. The set
    // of valid values is enforced in TypeScript (shared/src/runlog/classify-failure.ts)
    // rather than via a DB-level enum so future categories don't require a
    // migration.
    failureReason: text('failure_reason'),
    // Set when the daemon scheduler dispatches the run; nullable for
    // manually-triggered runs. Combined with `campaignId`, this powers a
    // partial UNIQUE index that prevents the same scheduled tick from
    // turning into two `runs` rows under contention.
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  },
  (t) => ({
    byProjectKind: index('runs_project_kind_idx').on(t.projectId, t.kind, t.startedAt.desc()),
  }),
);

export const stagingScoutCandidates = pgTable('staging_scout_candidates', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  raw: jsonb('raw').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
});

export const drafts = pgTable(
  'drafts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    platformId: integer('platform_id')
      .notNull()
      .references(() => platforms.id),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('pending_review'),
    fitScore: smallint('fit_score'),
    targetUser: text('target_user'),
    sourceRef: jsonb('source_ref').notNull().default({}),
    title: text('title'),
    body: text('body').notNull(),
    composeUrl: text('compose_url'),
    reasoning: text('reasoning'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentContent: text('sent_content'),
    platformCommentId: text('platform_comment_id'),
    platformPostId: text('platform_post_id'),
    // Optimistic-locking version bumped on every state-changing update so
    // concurrent reject/send/approve writes don't silently overwrite each other.
    version: integer('version').notNull().default(0),
    // When set, a previous outreach to the same target user occurred within the
    // dedup window; surfaced as a warning badge in the inbox.
    dedupWarning: text('dedup_warning'),
    // True once a reviewer has manually edited the draft body before approval.
    bodyEdited: boolean('body_edited').notNull().default(false),
    // Optional scheduled send-after time: drafts are excluded from "ready to
    // send" until this timestamp is in the past.
    scheduledSendAfter: timestamp('scheduled_send_after', { withTimezone: true }),
    // Number of times the draft body has been regenerated via the runner.
    regenerationCount: integer('regeneration_count').notNull().default(0),
    // LLM-judge quality scoring (issue #41). Score is 0-100; reason and model
    // are recorded for audit. Nullable when scoring is disabled or pending.
    qualityScore: smallint('quality_score'),
    qualityReason: text('quality_reason'),
    qualityModel: text('quality_model'),
    // A/B variant grouping (issue #20). Drafts sharing the same
    // `variant_group_id` are sibling variants for the same target; approving
    // one cascade-rejects the others with reason `variant_lost`. Stored as
    // text (UUID-shaped) rather than uuid to keep migrations cheap.
    variantGroupId: text('variant_group_id'),
    variantLabel: text('variant_label'),
    // Reply drafting (issue #49). When a draft is a continuation in an existing
    // thread, `parent_message_id` points at the inbound `messages` row that
    // triggered drafting. `drafts.kind` accepts 'reply_dm' / 'reply_comment'
    // alongside the existing outbound kinds.
    parentMessageId: bigint('parent_message_id', { mode: 'number' }),
  },
  (t) => ({
    byState: index('drafts_state_idx').on(t.state),
    byProject: index('drafts_project_idx').on(t.projectId),
    byStateRun: index('drafts_state_run_idx').on(t.state, t.runId),
    byStateRunCreated: index('drafts_state_campaign_created_idx').on(
      t.state,
      t.runId,
      t.createdAt.desc(),
    ),
    byVariantGroup: index('drafts_variant_group_idx').on(t.variantGroupId),
  }),
);

export const draftEvents = pgTable(
  'draft_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    draftId: integer('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    actor: text('actor').notNull(),
    details: jsonb('details').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byKindCreated: index('draft_events_kind_created_idx').on(t.event, t.createdAt),
  }),
);

export const draftRegenerationHints = pgTable('draft_regeneration_hints', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  draftId: integer('draft_id')
    .notNull()
    .references(() => drafts.id, { onDelete: 'cascade' }),
  hintText: text('hint_text'),
  authorUserId: integer('author_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const blocklist = pgTable('blocklist', {
  id: serial('id').primaryKey(),
  platformId: integer('platform_id')
    .notNull()
    .references(() => platforms.id),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  reason: text('reason'),
  scope: text('scope').notNull().default('global'),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contactHistory = pgTable(
  'contact_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    platformId: integer('platform_id')
      .notNull()
      .references(() => platforms.id),
    accountHandle: text('account_handle').notNull(),
    targetUser: text('target_user').notNull(),
    lastContactedAt: timestamp('last_contacted_at', { withTimezone: true }).notNull().defaultNow(),
    draftId: integer('draft_id').references(() => drafts.id, { onDelete: 'set null' }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    replyCheckedAt: timestamp('reply_checked_at', { withTimezone: true }),
    chatRoomId: text('chat_room_id'),
    platformContextUrl: text('platform_context_url'),
  },
  (t) => ({
    byTarget: index('contact_history_target_idx').on(t.platformId, t.targetUser),
    // Lookup used by dm-sync to attribute incoming Reddit DMs by
    // (accountHandle, targetUser). Index name preserved from issue #44.
    byAccountTarget: index('messages_account_target_idx').on(t.accountHandle, t.targetUser),
  }),
);

export const appConfig = pgTable('app_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

export const daemonHeartbeats = pgTable('daemon_heartbeats', {
  module: text('module').primaryKey(),
  tickAt: timestamp('tick_at', { withTimezone: true }).notNull().defaultNow(),
});

export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    raw: text('raw').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRun: index('run_events_run_idx').on(t.runId, t.seq),
    byKindCreated: index('run_events_kind_created_idx').on(t.kind, t.createdAt),
  }),
);

export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    payload: jsonb('payload').notNull().default({}),
    severity: text('severity').notNull().default('info'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUnread: index('notifications_unread_idx').on(t.readAt, t.createdAt.desc()),
  }),
);

export const extensionDevices = pgTable(
  'extension_devices',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    label: text('label').notNull().default('Unnamed device'),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSyncStatus: jsonb('last_sync_status'),
  },
  (t) => ({
    byHash: uniqueIndex('extension_devices_token_hash_unique').on(t.tokenHash),
  }),
);

export type ExtensionSyncChannelStatus = 'ok' | 'unauthorized' | 'error' | 'unknown';

export type ExtensionDeviceSyncStatus = {
  chat: ExtensionSyncChannelStatus;
  legacy: ExtensionSyncChannelStatus;
  captured_at: string;
  updated_at: string;
};

export const extensionPairings = pgTable('extension_pairings', {
  code: text('code').primaryKey(),
  organizationId: integer('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contactHistory.id, { onDelete: 'cascade' }),
    draftId: integer('draft_id').references(() => drafts.id, { onDelete: 'set null' }),
    platformId: integer('platform_id')
      .notNull()
      .references(() => platforms.id),
    author: text('author').notNull(),
    isFromUs: boolean('is_from_us').notNull().default(false),
    body: text('body').notNull(),
    platformMessageId: text('platform_message_id').notNull(),
    createdAtPlatform: timestamp('created_at_platform', { withTimezone: true }).notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull(),
  },
  (t) => ({
    byContact: index('messages_contact_idx').on(t.contactId, t.createdAtPlatform),
    uniquePlatformMessage: uniqueIndex('messages_platform_message_unique').on(
      t.platformId,
      t.platformMessageId,
    ),
  }),
);

// Outbound webhook delivery queue. The notifier enqueues a row with
// status='pending'; the daemon's webhook-sender worker drains pending/due rows,
// POSTs the payload, and on failure schedules a retry via computeBackoff().
// Once attempts >= max_attempts the row flips to 'dead' (DLQ) for manual retry.
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'dead';

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    webhookId: text('webhook_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').$type<WebhookDeliveryStatus>().notNull().default('pending'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    recentIdx: index('webhook_deliveries_recent_idx').on(t.createdAt),
  }),
);

// Few-shot templates per project. Used by playbooks (injected into
// `pitchbox run:start` output) to ground drafts with examples that match the
// project's voice. Campaign-level overrides may land later via a jsonb field
// on `campaigns`; V1 only supports project + kind filtering.
export const templates = pgTable(
  'templates',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'dm' | 'comment' | 'post'
    title: text('title').notNull(),
    body: text('body').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byProjectKind: index('templates_project_kind_idx').on(t.projectId, t.kind, t.isActive),
  }),
);

// Reactive triggers: poll a subreddit's new posts/comments and dispatch the
// linked campaign when a pattern hits. The daemon's keyword-watcher worker
// drives this loop; `lastSeenAt` doubles as the cooldown anchor.
export const keywordWatches = pgTable(
  'keyword_watches',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    subreddit: text('subreddit').notNull(),
    pattern: text('pattern').notNull(),
    matchField: text('match_field').notNull(), // 'title' | 'selftext' | 'comment'
    isActive: boolean('is_active').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    cooldownMinutes: integer('cooldown_minutes').notNull().default(30),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCampaign: index('keyword_watches_campaign_idx').on(t.campaignId, t.isActive),
    byProject: index('keyword_watches_project_idx').on(t.projectId, t.isActive),
  }),
);

// LLM-summarized reflections on a project's outreach history. Generated by the
// `project-insighter` playbook (or manual "Regenerate now"); the dashboard's
// Project → Insights tab renders the most recent row as Markdown. Evidence is
// a free-form jsonb payload that typically cites draft/message IDs.
export const projectInsights = pgTable(
  'project_insights',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    summaryMd: text('summary_md').notNull(),
    evidence: jsonb('evidence').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byProject: index('project_insights_project_idx').on(t.projectId, t.generatedAt),
  }),
);
