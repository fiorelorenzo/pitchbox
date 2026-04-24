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

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  defaultAgentRunner: text('default_agent_runner').notNull().default('claude-code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectConfigs = pgTable(
  'project_configs',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqKeyVersion: uniqueIndex('project_configs_key_version_uq').on(t.projectId, t.key, t.version),
  }),
);

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
  cookieSession: bytea('cookie_session'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
});

export const runs = pgTable('runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  campaignId: integer('campaign_id')
    .notNull()
    .references(() => campaigns.id, { onDelete: 'cascade' }),
  agentRunner: text('agent_runner').notNull().default('claude-code'),
  trigger: text('trigger').notNull(),
  status: text('status').notNull().default('queued'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
  stdoutLogPath: text('stdout_log_path'),
  tokensUsed: integer('tokens_used'),
});

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
    subreddit: text('subreddit'),
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
  },
  (t) => ({
    byState: index('drafts_state_idx').on(t.state),
    byProject: index('drafts_project_idx').on(t.projectId),
  }),
);

export const draftEvents = pgTable('draft_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  draftId: integer('draft_id')
    .notNull()
    .references(() => drafts.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  actor: text('actor').notNull(),
  details: jsonb('details').notNull().default({}),
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
  }),
);

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
