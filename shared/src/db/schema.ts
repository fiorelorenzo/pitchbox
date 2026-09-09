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

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    // Instance-wide admin, distinct from per-org 'admin' role. Gates global
    // config that spans every tenant (default runner, quota defaults, webhook
    // config) - a self-created org owner must NOT get this for free.
    isInstanceAdmin: boolean('is_instance_admin').notNull().default(false),
    // Nullable: accounts created before #507 (first-run bootstrap,
    // `pitchbox seed:owner`) have none, and nothing in the app requires one
    // for those to keep working. Required at `POST /api/auth/register`
    // (#504) since open sign-up (#505) makes the address the only thing
    // tying a self-registered account to a person, and later the way back in
    // after a lost password. Always written already normalized (trimmed,
    // lowercased, see `normalizeEmail` in `shared/src/auth.ts`), so the
    // unique index below is a plain column constraint rather than an
    // expression index, and two logins differing only in case collide.
    email: text('email'),
    // Set the moment the account proves control of `email` by redeeming a
    // single-use link (`email_verification_tokens` below) - null means
    // unverified. #514: a self-registered account can spend real money
    // through a run, so an unproven address must not be trusted the same
    // as a proven one. Two accounts intentionally start non-null here
    // rather than going through a link: one whose invite (`org_invites.
    // email`) already named this exact address (the inviter's vouching
    // stands in for the mail round trip - see `createUserRecord` /
    // `POST /api/auth/register`), and any pre-#507 account with `email`
    // still null, which `isEmailVerified` treats as verified since it has
    // nothing to prove and no way to ever clear this column.
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Postgres treats each NULL as distinct in a unique index, so accounts
    // with no email never collide with each other - only two non-null,
    // already-normalized addresses do.
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
  }),
);

export const organizations = pgTable('organizations', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Per-org cloud-runner quota (CLD-P5, docs/cloud-runner-productionization-design.md
  // section 5). Both nullable with no backfill: null means unlimited on that axis.
  // monthlyRunBudgetUsd caps calendar-month run cost (shared/src/org-quota.ts sums
  // runs.cost_usd for the org); maxConcurrentRuns caps how many runs.status='running'
  // rows the org may hold at once, admitted by
  // shared/src/org-quota.ts's assertOrgConcurrencyAdmitted (#485 - the old runner
  // service's in-memory per-org session map disappeared with the service in #420,
  // and nothing replaced it until this).
  monthlyRunBudgetUsd: numeric('monthly_run_budget_usd', { precision: 10, scale: 2 }),
  maxConcurrentRuns: integer('max_concurrent_runs'),
  // The plan an org is on (#544, shared/src/plans.ts's PlanId) and where that
  // value came from - not itself an entitlement source, a *record* of the
  // most recent decision so setOrgPlan (shared/src/orgs.ts) has something to
  // update atomically with the derived monthlyRunBudgetUsd/maxConcurrentRuns
  // above. `resolveEntitlements` (shared/src/plans.ts) is what actually
  // reads the numbers a plan means; this column is the input to that
  // resolution, not a duplicate of its output.
  // 'default': nobody has decided anything - a fresh org, always 'free'.
  // 'grant': an instance admin set it by hand (setOrgPlan), and wins over
  // any org_subscriptions row below.
  // 'stripe': the last write came from the Stripe webhook (#551).
  plan: text('plan').notNull().default('free'),
  planSource: text('plan_source').notNull().default('default'),
  planUpdatedAt: timestamp('plan_updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// The Stripe side of a plan (#544, #551 writes it): a subscription has its
// own lifecycle independent of the org's - it can lapse, get cancelled, or
// simply vanish (a customer asking Stripe to delete their data removes the
// Stripe objects from our account too, docs/billing.md "Emails and
// support"), none of which is an event that happens to `organizations`
// itself. A separate table, one row per org, rather than more nullable
// columns on `organizations`, so that disappearance is a row delete
// (`resolveEntitlements` falls through to the plan catalogue) instead of a
// pile of columns that must be nulled out in lockstep.
//
// `limit_*` mirrors the product metadata `scripts/stripe-setup.ts` writes
// (docs/billing.md "The plan catalogue lives in Stripe, not in the code"):
// `limit_devices`/etc. follow the same convention the script already uses,
// where the *string* `'0'` in Stripe metadata means unlimited on that axis
// - the webhook handler that populates this table is expected to parse
// that into a real SQL NULL before writing here, not store a literal 0.
// The webhook is expected to write every column atomically from the
// subscription's product metadata in one insert/update, never leave a row
// half populated - `resolveEntitlements` prefers this row wholesale over
// the code catalogue once it exists, it does not merge field by field.
export const orgSubscriptions = pgTable(
  'org_subscriptions',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    // The plan the subscription's Stripe product names (its `metadata.plan`),
    // mirrored here rather than re-derived from a price id lookup on every
    // read. May outrun `organizations.plan` for one webhook delivery; the
    // webhook is expected to write both in the same transaction.
    planId: text('plan_id').notNull(),
    // Stripe subscription status verbatim ('active', 'trialing', 'past_due',
    // 'canceled', ...) - the grace-window and read-only handling that reads
    // this is #548/#556, not built here.
    status: text('status').notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    limitRuns: integer('limit_runs'),
    limitSuggestions: integer('limit_suggestions'),
    limitProjects: integer('limit_projects'),
    limitSeats: integer('limit_seats'),
    limitDevices: integer('limit_devices'),
    limitConcurrency: integer('limit_concurrency'),
    limitBudgetUsd: numeric('limit_budget_usd', { precision: 10, scale: 2 }),
    limitRetentionDays: integer('limit_retention_days'),
    limitPremiumModels: boolean('limit_premium_models').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: uniqueIndex('org_subscriptions_org_unique').on(t.organizationId),
    byStripeSubscription: uniqueIndex('org_subscriptions_stripe_subscription_unique').on(
      t.stripeSubscriptionId,
    ),
  }),
);

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

export const orgInvites = pgTable(
  'org_invites',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    email: text('email'),
    role: text('role').notNull().default('member'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    byOrg: index('org_invites_org_idx').on(t.organizationId),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activeOrganizationId: integer('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
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
    // Either the IP address or the submitted username - both buckets are
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

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Hashed at rest, same convention as extension_devices.token_hash
    // (shared/src/db/schema.ts, extensionDevices below): the raw token is
    // only ever in the emailed link, never written to the database, so a
    // read of this table (backup, replica, compromised credential) cannot
    // be turned into an account takeover.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Single use: null until the token is redeemed, set exactly once by the
    // same atomic UPDATE that checks it's still null (shared/src/auth.ts's
    // consumePasswordResetToken) - a second redemption attempt matches zero
    // rows instead of racing a separate delete.
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('password_reset_tokens_token_hash_unique').on(t.tokenHash),
    byUser: index('password_reset_tokens_user_idx').on(t.userId),
  }),
);

// email_verification_tokens (#514): backs POST /api/auth/verify/confirm and
// /api/auth/verify/resend. Exactly `password_reset_tokens`' shape above -
// hashed at rest, single use, time-limited - reused on purpose rather than
// invented fresh, since both are "prove control of this mailbox" tokens
// with the same threat model. The TTL just lives in shared/src/auth.ts
// instead of here, same as password_reset_tokens' does.
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('email_verification_tokens_token_hash_unique').on(t.tokenHash),
    byUser: index('email_verification_tokens_user_idx').on(t.userId),
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

export const projects = pgTable(
  'projects',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    defaultAgentRunner: text('default_agent_runner').notNull().default('claude-code'),
    // Per-project voice override (#408): null on both means "inherit the
    // org's linkedin_assist tone", the same way an unset app_config row does
    // - see resolveEffectiveVoice in linkedin-assist.ts, the one place that
    // fallback is decided. Not an enum: the tone vocabulary lives in
    // assist/tone.ts and this column can otherwise drift the same way the
    // org setting's jsonb can, which resolveEffectiveVoice already guards
    // against by falling through on an unrecognised value.
    voiceTone: text('voice_tone'),
    voiceToneNotes: text('voice_tone_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgSlugUnique: uniqueIndex('projects_org_slug_unique').on(t.organizationId, t.slug),
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
  isDefault: boolean('is_default').notNull().default(false),
  cookieSession: bytea('cookie_session'),
  // Mastodon-specific credentials (nullable - only populated once a Mastodon
  // account is connected). instanceUrl is the plain instance base URL (e.g.
  // "https://mastodon.social"); accessTokenEncrypted stores the developer
  // access token encrypted with ENCRYPTION_KEY via shared/src/crypto.ts, same
  // packed "iv:tag:ciphertext" format used everywhere else in the codebase.
  instanceUrl: text('instance_url'),
  accessTokenEncrypted: text('access_token_encrypted'),
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
  // Opt-in per-campaign auto-post (MAS-5, Mastodon only today): when true, an
  // approved draft is sent via the platform's API immediately instead of
  // waiting for the human to send it manually. Defaults to false - manual
  // send stays the default for every platform.
  autoPost: boolean('auto_post').notNull().default(false),
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

// `project_description_refresh` (#434): a proposed re-derivation of a
// project's description after its sources changed, or the decision on one.
// No dedicated table - `params` carries `{ decision: 'accepted'|'declined',
// proposedDescription, previousDescription, sourceIds }` and `status` is
// always 'success' (the derivation itself is synchronous and deterministic,
// never a model call - see shared/src/project-description-refresh.ts). Only
// a decision is ever persisted; the proposal shown to an operator is
// computed on demand and never written until accepted or declined.

export const runs = pgTable(
  'runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull().default('campaign'), // 'campaign' | 'project_extraction' | 'campaign_skill_generation' | 'draft_regeneration' | 'reply_drafting' | 'project_insights' | 'assist' | 'project_description_refresh'
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

// Posts the browser observed on linkedin.com outside of any campaign run -
// LinkedIn has no discovery API, so an asynchronous LinkedIn campaign has no
// targets unless the extension supplies them (see
// docs/linkedin-integration-design.md, "Observation collection"/"Storage").
// `staging_scout_candidates` above cannot hold these: it is `run_id NOT NULL`
// with `onDelete: 'cascade'`, so a row cannot exist before the run that
// consumes it, and an observation arrives with no run in sight.
//
// LinkedIn serves two frontends and only one exposes a stable per-post
// identifier (design doc, "Two frontends, one identifier", corrected
// 2026-09-03): the feed's server-driven UI has no `data-urn` at all, only a
// render address that changes on reload, while a post detail page - the post
// the human actually opened - carries the real URN. `external_id` is
// therefore a generic column, not a URN-typed one: it is populated only for
// a sighting with a genuine stable identifier, and the collector (#302) must
// never call the ingest service for a feed sighting that has none.
export const observedTargets = pgTable(
  'observed_targets',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Both organization and project carried directly (not only reachable
    // through a join), following #263's contact_history precedent: a row
    // visible to no organization is a silent way to leak dedup across
    // tenants. project_id is direct too because the drain (#304) and this
    // table's own dedup are project-scoped - an org running several
    // LinkedIn projects must not let a post scrolled for one seed another's
    // candidate pool.
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    platformId: integer('platform_id')
      .notNull()
      .references(() => platforms.id),
    // The stable per-frontend identifier (an activity or comment URN on
    // LinkedIn today). Never absent - see the table comment above.
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    authorHandle: text('author_handle'),
    authorName: text('author_name'),
    text: text('text'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    // Set once `linkedin_candidates` (#304) drains this row into
    // staging_scout_candidates for a run. The row stays in place rather than
    // being deleted, so a repeat sighting of the same post after
    // consumption still hits the unique index below and does not resurrect
    // it as a fresh, unconsumed candidate.
    consumedByRunId: integer('consumed_by_run_id').references(() => runs.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    // Dedup key (issue #300): a repeat sighting of the same post while the
    // human scrolls must be a no-op via onConflictDoNothing, not a second
    // row. Deliberately NOT partial on consumed_by_run_id - the whole point
    // is that a re-sighting of an already-consumed post must also be a
    // no-op rather than resurrecting it (see verifying-on-conflict-dedupe:
    // a partial predicate here would stop covering a row the moment it gets
    // consumed, which is exactly the state a repeat sighting must still
    // hit). organization_id leads the index, not just platform_id +
    // external_id, because a public post is observable by more than one
    // tenant's browser and each tenant's ingest must get its own row.
    dedup: uniqueIndex('observed_targets_dedup_idx').on(
      t.organizationId,
      t.platformId,
      t.externalId,
    ),
    // Drives the drain (#304): unconsumed rows for a project, oldest first.
    byProjectUnconsumed: index('observed_targets_project_unconsumed_idx').on(
      t.projectId,
      t.consumedByRunId,
      t.observedAt,
    ),
  }),
);

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
    // When set, a draft_regeneration run is in flight rewriting this draft's
    // body; drives the inbox "regenerating" state and the single-flight guard.
    // Cleared when the run finishes (in draft_regen_finish on success, else by
    // the dispatcher).
    regeneratingRunId: integer('regenerating_run_id').references(() => runs.id, {
      onDelete: 'set null',
    }),
    // When set, a reply_drafting run is in flight producing this reply draft's
    // body; drives the inbox "drafting" state, blocks approve/send, and is the
    // single-flight guard. Cleared only by reply_draft_finish on success; left
    // set on failure so the placeholder stays non-approvable (the UI offers
    // Retry).
    draftingRunId: integer('drafting_run_id').references(() => runs.id, {
      onDelete: 'set null',
    }),
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
    // Issue #335: the platform's own reason string, kept verbatim, once a
    // DM draft turns out to be undeliverable (Reddit disabling Send with
    // "unable to send a message request to this account" is the first
    // case). Set only when state flips to 'undeliverable'.
    undeliverableReason: text('undeliverable_reason'),
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
    // #263: the tenant this contact belongs to, set from the draft's project at
    // insert time so it survives retention pruning the draft (draft_id -> null).
    // Not null: a contact that belongs to no organization is visible to nobody,
    // which is a silent way to lose data. Every user-facing read filters on this
    // column, so contact dedup no longer crosses tenants - see the dedup section
    // of docs/organization-isolation-design.md for what that trades away.
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, {
        onDelete: 'cascade',
      }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    replyCheckedAt: timestamp('reply_checked_at', { withTimezone: true }),
    chatRoomId: text('chat_room_id'),
    platformContextUrl: text('platform_context_url'),
    // Issue #335: sticky "this account cannot be messaged" fact, distinct
    // from an ordinary prior contact - checkUncontactable
    // (shared/src/contact-dedup.ts) reads it with no time window, unlike
    // checkContactDedup's windowed warn/skip. reason keeps the platform's
    // own wording verbatim (the same string drafts.undeliverable_reason
    // carries on the draft that produced this row).
    uncontactable: boolean('uncontactable').notNull().default(false),
    uncontactableReason: text('uncontactable_reason'),
  },
  (t) => ({
    byTarget: index('contact_history_target_idx').on(t.platformId, t.targetUser),
    // Lookup used by dm-sync to attribute incoming Reddit DMs by
    // (accountHandle, targetUser). Index name preserved from issue #44.
    byAccountTarget: index('messages_account_target_idx').on(t.accountHandle, t.targetUser),
    // Supports the org-scoped dm-sync freshness lookup and, since #263, every
    // org-scoped listing (organization_id + platform_id + last_contacted_at).
    byOrg: index('contact_history_org_idx').on(t.organizationId, t.platformId, t.lastContactedAt),
  }),
);

export const appConfig = pgTable('app_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

// Instance-wide config writes (#414): a model swapped for every tenant, a
// quota default raised, an account promoted - none of it org-scoped, so it
// cannot live in the union `audit-feed.ts` builds from draft_events and
// run_events (both reached through a project's organization_id, which this
// has none of). `key` names the app_config row (or app_config-shaped
// concern) that changed - 'default_runner', 'quota_defaults',
// 'runner_config:<slug>', 'notification_webhooks', 'retention',
// 'model_function:<fn>', 'registration_policy', 'user_promotion' - `before`/
// `after` hold the value
// on each side of the write, run through `redactInstanceAuditValue`
// (shared/src/instance-audit.ts) before they ever reach this table so a
// credential-shaped field is never stored raw. `recordInstanceAudit` is the
// one function that inserts here - see that module for why every
// instance-wide write is expected to call it rather than writing directly.
export const instanceAuditLog = pgTable(
  'instance_audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: text('key').notNull(),
    actor: text('actor').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCreated: index('instance_audit_log_created_idx').on(t.createdAt),
  }),
);

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
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    byOrg: index('notifications_org_idx').on(t.organizationId, t.createdAt.desc()),
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
    // Token lifecycle (issue #185). Nullable so existing rows (and any device
    // minted before this landed) stay valid forever; every new device token
    // (auto-pair, pairing-code redemption, rotate) is minted with this set to
    // now + 90 days. requireExtensionAuth rejects a request once this is set
    // and in the past, but never treats a null expiry as expired.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
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

// Per-suggestion usage ledger for the in-page LinkedIn assistant (#522).
// `POST /api/extension/suggest` deliberately writes no `runs` row (see the
// header comment on that route) and, before this table, a suggestion's cost
// reached the database only if a human accepted it - a panel that streams
// twenty suggestions of which two are used had nineteen invisible ones as
// far as the ledger was concerned. This is the fix: one row per finished
// suggestion, written the moment the stream ends regardless of whether it is
// ever accepted, so `getOrgMonthToDateCostUsd` (org-quota.ts) sees the whole
// cost of the feature rather than the fraction someone chose to keep.
//
// A dedicated table rather than a synthetic `runs` row per suggestion, on
// purpose: the run list and the analytics that read it are about outreach
// activity, and nineteen invisible-to-a-human "runs" per twenty suggestions
// would pollute both. `organizationId` is nullable (mirrors
// extension_devices/extension_pairings: a self-host device paired with auth
// off has no org), `projectId` is not - a suggestion is always grounded in
// one project. `deviceId` is `set null` rather than `cascade` so revoking or
// deleting a device never erases spend history already counted against a
// budget.
export const assistUsage = pgTable(
  'assist_usage',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: integer('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    deviceId: integer('device_id').references(() => extensionDevices.id, {
      onDelete: 'set null',
    }),
    platformId: integer('platform_id')
      .notNull()
      .references(() => platforms.id),
    kind: text('kind').notNull(), // 'post_comment' | 'post' - assist/suggest-prompt.ts's SuggestionKind
    agentRunner: text('agent_runner').notNull(),
    // The resolved model the suggestion actually asked for (e.g. 'sonnet',
    // the ACP alias - see suggest.ts's ASSIST_DEFAULT_MODEL - or a Gateway
    // model id for the cloud runner). Kept even when cost is null so a price
    // table gap can be closed once, later, without re-deriving which model
    // every historical suggestion used.
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),
    // The runner's own cost figure for this suggestion - self-reported by
    // the backend when available, otherwise computed from the token columns
    // above via the runner's price table (shared/src/runlog/usage.ts,
    // shared/src/agents/sdk/event-normalizer.ts). Never client-supplied:
    // this is written from the server's own AgentRunner result before the
    // panel ever sees it, unlike the usage block `/suggest/accept` receives
    // back from the extension (see assist-accept.ts). Null when the backend
    // reported nothing and pricing for its model is unknown - a residual gap
    // named in #522's PR body, not silently priced at a guess.
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgCreated: index('assist_usage_org_created_idx').on(t.organizationId, t.createdAt),
    byProjectCreated: index('assist_usage_project_created_idx').on(t.projectId, t.createdAt),
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

// Outbound webhook delivery queue. The notifier enqueues a row with
// status='pending'; the daemon's webhook-sender worker drains pending/due rows,
// POSTs the payload, and on failure schedules a retry via computeBackoff().
// Once attempts >= max_attempts the row flips to 'dead' (DLQ) for manual retry.
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'dead';

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    byOrg: index('webhook_deliveries_org_idx').on(t.organizationId, t.createdAt.desc()),
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
    // Failure-backoff state (mirrors the campaign circuit breaker in
    // `campaigns.failureAttempts`/`nextAttemptAfter`). `consecutiveFailures`
    // counts consecutive fetch failures for r/{subreddit}/new.json, reset to 0
    // on a successful fetch. Once it reaches the backoff threshold,
    // `nextAttemptAfter` spaces out further attempts exponentially and a
    // `keyword_watch.failing` notification is raised.
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    nextAttemptAfter: timestamp('next_attempt_after', { withTimezone: true }),
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

// The operator's own persona: who the human writing through the in-page
// assistant actually is. One row per organization, because the assistant
// writes as a person and an organization here is that person's workspace.
//
// Populated by the extension when the human opens their OWN LinkedIn profile
// (docs/linkedin-integration-design.md's rule 2 allows reading the DOM their
// navigation already rendered and nothing more), and editable by hand from
// Settings, which is why `source` records where the current text came from:
// a manual edit is not overwritten by a later capture without the human
// asking for it.
export const operatorProfiles = pgTable(
  'operator_profiles',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** LinkedIn vanity handle, when a capture supplied one. Not a credential. */
    handle: text('handle'),
    displayName: text('display_name'),
    headline: text('headline'),
    about: text('about'),
    /** `[{ title, company, period, summary }]` as rendered on the profile. */
    experiences: jsonb('experiences').notNull().default([]),
    /** Free text the human writes about how they want to sound. Never captured. */
    notes: text('notes'),
    source: text('source').notNull().default('linkedin_capture'), // 'linkedin_capture' | 'manual'
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: uniqueIndex('operator_profiles_org_unique').on(t.organizationId),
  }),
);

// The operator's own recent posts, captured passively from their activity page
// and used as few-shot voice samples. These are examples of how this person
// writes, which is a different thing from `templates` (hand-written patterns
// for a project's outreach) and is why they do not share a table.
//
// `excluded` rather than a delete: a sample the human does not want in the
// prompt should stay visible in Settings, otherwise the next capture silently
// brings it back.
export const operatorVoiceSamples = pgTable(
  'operator_voice_samples',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The post's stable identifier on the platform, and the dedup key. */
    externalId: text('external_id').notNull(),
    platformId: integer('platform_id')
      .notNull()
      .references(() => platforms.id),
    text: text('text').notNull(),
    url: text('url'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    excluded: boolean('excluded').notNull().default(false),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgExternal: uniqueIndex('operator_voice_samples_org_external_unique').on(
      t.organizationId,
      t.externalId,
    ),
    byOrgExcluded: index('operator_voice_samples_org_idx').on(t.organizationId, t.excluded),
  }),
);

// The operator's voice, derived from what they have actually written
// (#407): the same voice samples above, the messages and sent drafts that
// went out, and the project templates - a measurement, not a model call,
// for the same reasons `shared/src/assist/register.ts` gives (#406):
// nondeterminism, latency on a path a human is watching, and a summary a
// model could phrase five different ways is not something a test can pin.
// One row per organization, same shape as `operator_profiles`.
//
// `source` follows `operator_profiles`' own convention: 'derived' is
// recomputed by `refreshVoiceProfile` whenever new material arrives,
// 'manual' is a human's hand-edited summary and is left alone by a refresh
// until the human asks for a reset - a wrong voice profile is worse than
// none, so an edit correcting one must survive the next capture.
//
// `evidence` records what the derivation actually read (ids and counts per
// source), so the Settings page can show its reasoning and a refresh does
// not need to re-justify itself. `traits`/`openings`/`closings`/
// `common_words` are the measured building blocks behind `summary`'s prose;
// kept alongside it so a future re-render of the same measurement does not
// require re-deriving it.
export const operatorVoiceProfiles = pgTable(
  'operator_voice_profiles',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The prose carried into the suggestion prompt. Empty when the corpus
     * has never been large enough to say anything honest. */
    summary: text('summary').notNull().default(''),
    traits: jsonb('traits').notNull().default([]),
    openings: jsonb('openings').notNull().default([]),
    closings: jsonb('closings').notNull().default([]),
    commonWords: jsonb('common_words').notNull().default([]),
    wordsPerSentence: integer('words_per_sentence').notNull().default(0),
    itemCount: integer('item_count').notNull().default(0),
    wordCount: integer('word_count').notNull().default(0),
    /** `{ voiceSampleIds, messageIds, draftIds, templateIds, counts }` -
     * what this row was derived from. */
    evidence: jsonb('evidence').notNull().default({}),
    source: text('source').notNull().default('derived'), // 'derived' | 'manual'
    /** Set only on a real derivation, never on a manual edit - a manual
     * summary did not come from re-reading the corpus. */
    derivedAt: timestamp('derived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: uniqueIndex('operator_voice_profiles_org_unique').on(t.organizationId),
  }),
);

// A public code repository the operator points the companion at, so a
// suggestion can be grounded in what they actually built rather than in a
// project description written months ago.
//
// Public by URL and no credential (Lorenzo's call, 2026-09-07): the reader
// calls GitHub's anonymous API, caches what it read, and a private repository
// is out of scope until the optional GitHub App lands. `fetch_error` is kept
// so a repo that stopped resolving says so in Settings instead of quietly
// contributing nothing to every prompt.
//
// Organization-wide only (#431): this table used to carry an optional
// `project_id`, but nothing ever set it - every real caller
// (`/settings/companion`, `assist/context.ts`) reads across the whole org,
// never one project. A repo a project itself cites as a source is a
// `project_sources` row of kind 'github' instead (see below), so there is
// exactly one place that answers "what are this project's sources".
export const githubSources = pgTable(
  'github_sources',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    url: text('url').notNull(),
    description: text('description'),
    primaryLanguage: text('primary_language'),
    /** Clamped README text, not the whole file. */
    readmeExcerpt: text('readme_excerpt'),
    /** `[{ sha, message, committedAt }]`, newest first. */
    recentCommits: jsonb('recent_commits').notNull().default([]),
    active: boolean('active').notNull().default(true),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    fetchError: text('fetch_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgRepo: uniqueIndex('github_sources_org_repo_unique').on(t.organizationId, t.owner, t.repo),
  }),
);

// The optional GitHub App's installations (#390). Only the public half of the
// credential lives here: the installation id and which account granted it.
// The private key is a deployment secret read from the environment
// (`shared/src/github-app.ts`), never a row and never an `app_config` value.
//
// `installation_id` is unique across the whole table rather than per
// organization, and that is a security property rather than tidiness: an
// installation belongs to exactly one GitHub account, so letting two
// organizations claim the same one would let the second read the first's
// private repositories. A re-install onto an account another org already
// holds is refused (`recordInstallation`), not merged.
//
// There is no `project_id` and no per-source link: resolution is by account
// login (`installationTokenForOwner`), because that is what an installation
// actually scopes.
export const githubInstallations = pgTable(
  'github_installations',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** GitHub's own installation id. `bigint` because GitHub's ids are already
     * past what a 32-bit column holds (the two live ones are 160288218 and
     * 160289335), with mode 'number' since the value stays far inside
     * `Number.MAX_SAFE_INTEGER`. */
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    /** The account that installed it: a user or an organization login. This is
     * the join key for a repository's owner. */
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull().default('User'),
    /** `all` or `selected`, as GitHub reports it - worth showing an operator,
     * since `selected` explains why a repo he just created is invisible. */
    repositorySelection: text('repository_selection').notNull().default('selected'),
    /** What the installation actually granted, as GitHub reports it. Stored so
     * Settings can say "contents: read" rather than promising what the app
     * registration asks for, which an account is free to narrow. */
    permissions: jsonb('permissions').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byInstallation: uniqueIndex('github_installations_installation_unique').on(t.installationId),
    byOrg: index('github_installations_org_idx').on(t.organizationId),
  }),
);

// A project's set of sources (#431/#398): a project used to be described
// from exactly one thing at a time, chosen fresh on every extraction run
// (`cli/src/commands/project.ts`'s `folder` | `git` | `upload`, held only in
// `runs.params` and gone once the run's temp dir is cleaned up). This table
// makes a source a durable row instead, so a project can hold several at
// once, an extraction run's source survives past that one run, and a source
// can be removed without losing the others.
//
// Org scoping reaches this table the same way it reaches `campaigns`,
// `drafts` and `accounts`: through `projects.organization_id`, never a
// column of its own. `contact_history.organization_id` is the one place that
// pattern is broken, and only because its project link can go null when its
// draft is pruned (#263) - a project_sources row has no such path (its own
// `project_id` is `NOT NULL` and cascades with the project), so there is no
// reason to duplicate the pattern here.
//
// `kind` is `ProjectSourceKind` (shared/src/project-sources.ts): today's
// extraction inputs (`folder`, `git`, `upload`) and the GitHub cache
// (`github`), plus `website` (#433), the LinkedIn kinds #435 is spiking
// (`linkedin_company`, `linkedin_profile`, `linkedin_post`), and two
// read-only social adapters (#437: `mastodon_account`, `hackernews_author`)
// - a value nobody implements yet is fine, a second copy of this list
// elsewhere is not.
// `config` is the kind-specific input (a path, a URL, a repo/profile
// identifier); `output` is the kind-specific cached read (README excerpt,
// extracted page text, ...) an extraction or a re-derivation reads from
// instead of re-fetching on every prompt.
export const projectSources = pgTable(
  'project_sources',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'folder' | 'git' | 'upload' | 'github' | 'website' | 'linkedin_company' | 'linkedin_profile' | 'linkedin_post' | 'mastodon_account' | 'hackernews_author'
    config: jsonb('config').notNull().default({}),
    output: jsonb('output'),
    active: boolean('active').notNull().default(true),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    fetchError: text('fetch_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byProject: index('project_sources_project_idx').on(t.projectId, t.active),
  }),
);
