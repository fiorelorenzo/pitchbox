-- Baseline migration: faithful snapshot of the live schema (organization-isolation era).
-- Generated from pg_dump of the live DB so a fresh deploy reproduces it EXACTLY
-- (historical constraint names, all indexes, the runs_kind_target_chk CHECK).
-- The meta/0000_snapshot.json is drizzle's schema.ts view, used only by 'generate'.
-- Prior per-migration history is preserved under ../migrations_archive/.








COMMENT ON SCHEMA public IS 'standard public schema';





CREATE TABLE public.accounts (
    id integer NOT NULL,
    project_id integer NOT NULL,
    platform_id integer NOT NULL,
    handle text NOT NULL,
    display_name text,
    role text DEFAULT 'personal'::text NOT NULL,
    notes text,
    active boolean DEFAULT true NOT NULL,
    cookie_session bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    daily_limit integer,
    weekly_limit integer
);



CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;



CREATE TABLE public.app_config (
    key text NOT NULL,
    value jsonb NOT NULL
);



CREATE TABLE public.auth_failures (
    id bigint NOT NULL,
    identifier text NOT NULL,
    failed_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'login_attempt'::text NOT NULL
);



CREATE SEQUENCE public.auth_failures_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.auth_failures_id_seq OWNED BY public.auth_failures.id;



CREATE TABLE public.blocklist (
    id integer NOT NULL,
    platform_id integer NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    reason text,
    scope text DEFAULT 'global'::text NOT NULL,
    project_id integer,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.blocklist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.blocklist_id_seq OWNED BY public.blocklist.id;



CREATE TABLE public.campaign_recommendations (
    id integer NOT NULL,
    project_id integer NOT NULL,
    scenario_slug text NOT NULL,
    name text NOT NULL,
    objective text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.campaign_recommendations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.campaign_recommendations_id_seq OWNED BY public.campaign_recommendations.id;



CREATE TABLE public.campaigns (
    id integer NOT NULL,
    project_id integer NOT NULL,
    platform_id integer NOT NULL,
    name text NOT NULL,
    skill_slug text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    cron_expression text,
    rate_limit jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    agent_runner text DEFAULT 'claude-code'::text NOT NULL,
    failure_attempts integer DEFAULT 0 NOT NULL,
    next_attempt_after timestamp with time zone,
    paused_due_to_failures boolean DEFAULT false NOT NULL
);



CREATE SEQUENCE public.campaigns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.campaigns_id_seq OWNED BY public.campaigns.id;



CREATE TABLE public.contact_history (
    id bigint NOT NULL,
    platform_id integer NOT NULL,
    account_handle text NOT NULL,
    target_user text NOT NULL,
    last_contacted_at timestamp with time zone DEFAULT now() NOT NULL,
    draft_id integer,
    replied_at timestamp with time zone,
    reply_checked_at timestamp with time zone,
    chat_room_id text,
    platform_context_url text
);



CREATE SEQUENCE public.contact_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.contact_history_id_seq OWNED BY public.contact_history.id;



CREATE TABLE public.daemon_heartbeats (
    module text NOT NULL,
    tick_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.draft_events (
    id bigint NOT NULL,
    draft_id integer NOT NULL,
    event text NOT NULL,
    actor text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.draft_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.draft_events_id_seq OWNED BY public.draft_events.id;



CREATE TABLE public.draft_regeneration_hints (
    id bigint NOT NULL,
    draft_id integer NOT NULL,
    hint_text text,
    author_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.draft_regeneration_hints_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.draft_regeneration_hints_id_seq OWNED BY public.draft_regeneration_hints.id;



CREATE TABLE public.drafts (
    id bigint NOT NULL,
    run_id integer NOT NULL,
    project_id integer NOT NULL,
    platform_id integer NOT NULL,
    account_id integer NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'pending_review'::text NOT NULL,
    fit_score smallint,
    target_user text,
    source_ref jsonb DEFAULT '{}'::jsonb NOT NULL,
    title text,
    body text NOT NULL,
    compose_url text,
    reasoning text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    sent_at timestamp with time zone,
    sent_content text,
    platform_comment_id text,
    platform_post_id text,
    version integer DEFAULT 0 NOT NULL,
    dedup_warning text,
    body_edited boolean DEFAULT false NOT NULL,
    scheduled_send_after timestamp with time zone,
    regeneration_count integer DEFAULT 0 NOT NULL,
    quality_score smallint,
    quality_reason text,
    quality_model text,
    variant_group_id text,
    variant_label text,
    parent_message_id bigint,
    regenerating_run_id integer,
    drafting_run_id integer
);



CREATE SEQUENCE public.drafts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.drafts_id_seq OWNED BY public.drafts.id;



CREATE TABLE public.extension_devices (
    id integer NOT NULL,
    organization_id integer,
    label text DEFAULT 'Unnamed device'::text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_sync_status jsonb
);



CREATE SEQUENCE public.extension_devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.extension_devices_id_seq OWNED BY public.extension_devices.id;



CREATE TABLE public.extension_pairings (
    code text NOT NULL,
    organization_id integer,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.keyword_watches (
    id integer NOT NULL,
    project_id integer NOT NULL,
    campaign_id integer NOT NULL,
    subreddit text NOT NULL,
    pattern text NOT NULL,
    match_field text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_seen_at timestamp with time zone,
    cooldown_minutes integer DEFAULT 30 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.keyword_watches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.keyword_watches_id_seq OWNED BY public.keyword_watches.id;



CREATE TABLE public.memberships (
    id integer NOT NULL,
    organization_id integer NOT NULL,
    user_id integer NOT NULL,
    role text DEFAULT 'owner'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.memberships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.memberships_id_seq OWNED BY public.memberships.id;



CREATE TABLE public.messages (
    id bigint NOT NULL,
    contact_id bigint NOT NULL,
    draft_id integer,
    platform_id integer NOT NULL,
    author text NOT NULL,
    is_from_us boolean DEFAULT false NOT NULL,
    body text NOT NULL,
    platform_message_id text NOT NULL,
    created_at_platform timestamp with time zone NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL
);



CREATE SEQUENCE public.messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.messages_id_seq OWNED BY public.messages.id;



CREATE TABLE public.notifications (
    id bigint NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;



CREATE TABLE public.org_invites (
    id integer NOT NULL,
    organization_id integer NOT NULL,
    token text NOT NULL,
    email text,
    role text DEFAULT 'member'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    created_by_user_id integer
);



CREATE SEQUENCE public.org_invites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.org_invites_id_seq OWNED BY public.org_invites.id;



CREATE TABLE public.organizations (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.organizations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.organizations_id_seq OWNED BY public.organizations.id;



CREATE TABLE public.platforms (
    id integer NOT NULL,
    slug text NOT NULL,
    enabled boolean DEFAULT true NOT NULL
);



CREATE SEQUENCE public.platforms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.platforms_id_seq OWNED BY public.platforms.id;



CREATE TABLE public.playbooks (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    body text NOT NULL,
    is_builtin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.playbooks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.playbooks_id_seq OWNED BY public.playbooks.id;



CREATE TABLE public.project_insights (
    id integer NOT NULL,
    project_id integer NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    summary_md text NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.project_insights_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.project_insights_id_seq OWNED BY public.project_insights.id;



CREATE TABLE public.projects (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    default_agent_runner text DEFAULT 'claude-code'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id integer
);



CREATE SEQUENCE public.projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.projects_id_seq OWNED BY public.projects.id;



CREATE TABLE public.run_events (
    id bigint NOT NULL,
    run_id integer NOT NULL,
    seq integer NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    raw text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.run_events_id_seq OWNED BY public.run_events.id;



CREATE TABLE public.runs (
    id bigint NOT NULL,
    campaign_id integer,
    trigger text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    error text,
    stdout_log_path text,
    tokens_used integer,
    agent_runner text DEFAULT 'claude-code'::text NOT NULL,
    kind text DEFAULT 'campaign'::text NOT NULL,
    project_id integer,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    playbook_body text,
    failure_reason text,
    scheduled_for timestamp with time zone,
    input_tokens integer,
    output_tokens integer,
    cache_read_tokens integer,
    cache_creation_tokens integer,
    cost_usd numeric(10,4),
    CONSTRAINT runs_kind_target_chk CHECK ((((kind = 'campaign'::text) AND (campaign_id IS NOT NULL)) OR ((kind = 'project_extraction'::text) AND (project_id IS NOT NULL)) OR ((kind = 'campaign_skill_generation'::text) AND (campaign_id IS NOT NULL)) OR ((kind = 'draft_regeneration'::text) AND (project_id IS NOT NULL)) OR ((kind = 'reply_drafting'::text) AND (project_id IS NOT NULL)) OR ((kind = 'project_insights'::text) AND (project_id IS NOT NULL))))
);



CREATE SEQUENCE public.runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.runs_id_seq OWNED BY public.runs.id;



CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.staging_scout_candidates (
    id bigint NOT NULL,
    run_id integer NOT NULL,
    raw jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.staging_scout_candidates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.staging_scout_candidates_id_seq OWNED BY public.staging_scout_candidates.id;



CREATE TABLE public.templates (
    id integer NOT NULL,
    project_id integer NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.templates_id_seq OWNED BY public.templates.id;



CREATE TABLE public.users (
    id integer NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;



CREATE TABLE public.webhook_deliveries (
    id bigint NOT NULL,
    webhook_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 8 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE SEQUENCE public.webhook_deliveries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE public.webhook_deliveries_id_seq OWNED BY public.webhook_deliveries.id;



ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);



ALTER TABLE ONLY public.auth_failures ALTER COLUMN id SET DEFAULT nextval('public.auth_failures_id_seq'::regclass);



ALTER TABLE ONLY public.blocklist ALTER COLUMN id SET DEFAULT nextval('public.blocklist_id_seq'::regclass);



ALTER TABLE ONLY public.campaign_recommendations ALTER COLUMN id SET DEFAULT nextval('public.campaign_recommendations_id_seq'::regclass);



ALTER TABLE ONLY public.campaigns ALTER COLUMN id SET DEFAULT nextval('public.campaigns_id_seq'::regclass);



ALTER TABLE ONLY public.contact_history ALTER COLUMN id SET DEFAULT nextval('public.contact_history_id_seq'::regclass);



ALTER TABLE ONLY public.draft_events ALTER COLUMN id SET DEFAULT nextval('public.draft_events_id_seq'::regclass);



ALTER TABLE ONLY public.draft_regeneration_hints ALTER COLUMN id SET DEFAULT nextval('public.draft_regeneration_hints_id_seq'::regclass);



ALTER TABLE ONLY public.drafts ALTER COLUMN id SET DEFAULT nextval('public.drafts_id_seq'::regclass);



ALTER TABLE ONLY public.extension_devices ALTER COLUMN id SET DEFAULT nextval('public.extension_devices_id_seq'::regclass);



ALTER TABLE ONLY public.keyword_watches ALTER COLUMN id SET DEFAULT nextval('public.keyword_watches_id_seq'::regclass);



ALTER TABLE ONLY public.memberships ALTER COLUMN id SET DEFAULT nextval('public.memberships_id_seq'::regclass);



ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);



ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);



ALTER TABLE ONLY public.org_invites ALTER COLUMN id SET DEFAULT nextval('public.org_invites_id_seq'::regclass);



ALTER TABLE ONLY public.organizations ALTER COLUMN id SET DEFAULT nextval('public.organizations_id_seq'::regclass);



ALTER TABLE ONLY public.platforms ALTER COLUMN id SET DEFAULT nextval('public.platforms_id_seq'::regclass);



ALTER TABLE ONLY public.playbooks ALTER COLUMN id SET DEFAULT nextval('public.playbooks_id_seq'::regclass);



ALTER TABLE ONLY public.project_insights ALTER COLUMN id SET DEFAULT nextval('public.project_insights_id_seq'::regclass);



ALTER TABLE ONLY public.projects ALTER COLUMN id SET DEFAULT nextval('public.projects_id_seq'::regclass);



ALTER TABLE ONLY public.run_events ALTER COLUMN id SET DEFAULT nextval('public.run_events_id_seq'::regclass);



ALTER TABLE ONLY public.runs ALTER COLUMN id SET DEFAULT nextval('public.runs_id_seq'::regclass);



ALTER TABLE ONLY public.staging_scout_candidates ALTER COLUMN id SET DEFAULT nextval('public.staging_scout_candidates_id_seq'::regclass);



ALTER TABLE ONLY public.templates ALTER COLUMN id SET DEFAULT nextval('public.templates_id_seq'::regclass);



ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);



ALTER TABLE ONLY public.webhook_deliveries ALTER COLUMN id SET DEFAULT nextval('public.webhook_deliveries_id_seq'::regclass);



ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);



ALTER TABLE ONLY public.auth_failures
    ADD CONSTRAINT auth_failures_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.blocklist
    ADD CONSTRAINT blocklist_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.campaign_recommendations
    ADD CONSTRAINT campaign_recommendations_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.contact_history
    ADD CONSTRAINT contact_history_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.daemon_heartbeats
    ADD CONSTRAINT daemon_heartbeats_pkey PRIMARY KEY (module);



ALTER TABLE ONLY public.draft_events
    ADD CONSTRAINT draft_events_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.draft_regeneration_hints
    ADD CONSTRAINT draft_regeneration_hints_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.extension_devices
    ADD CONSTRAINT extension_devices_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.extension_pairings
    ADD CONSTRAINT extension_pairings_pkey PRIMARY KEY (code);



ALTER TABLE ONLY public.keyword_watches
    ADD CONSTRAINT keyword_watches_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_token_key UNIQUE (token);



ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);



ALTER TABLE ONLY public.platforms
    ADD CONSTRAINT platforms_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.platforms
    ADD CONSTRAINT platforms_slug_unique UNIQUE (slug);



ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_slug_key UNIQUE (slug);



ALTER TABLE ONLY public.project_insights
    ADD CONSTRAINT project_insights_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_slug_unique UNIQUE (slug);



ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.staging_scout_candidates
    ADD CONSTRAINT staging_scout_candidates_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.templates
    ADD CONSTRAINT templates_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);



ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);



CREATE UNIQUE INDEX accounts_one_default_per_project_platform ON public.accounts USING btree (project_id, platform_id) WHERE (is_default = true);



CREATE INDEX auth_failures_identifier_idx ON public.auth_failures USING btree (identifier, failed_at);



CREATE INDEX campaign_recommendations_project_idx ON public.campaign_recommendations USING btree (project_id, created_at DESC);



CREATE INDEX campaigns_project_idx ON public.campaigns USING btree (project_id);



CREATE INDEX contact_history_reply_check_idx ON public.contact_history USING btree (reply_checked_at) WHERE (replied_at IS NULL);



CREATE INDEX contact_history_target_idx ON public.contact_history USING btree (platform_id, target_user);



CREATE INDEX draft_events_kind_created_idx ON public.draft_events USING btree (event, created_at);



CREATE INDEX drafts_account_created_idx ON public.drafts USING btree (account_id, created_at DESC);



CREATE INDEX drafts_parent_message_idx ON public.drafts USING btree (parent_message_id);



CREATE INDEX drafts_platform_comment_idx ON public.drafts USING btree (platform_comment_id) WHERE (platform_comment_id IS NOT NULL);



CREATE INDEX drafts_project_idx ON public.drafts USING btree (project_id);



CREATE INDEX drafts_state_campaign_created_idx ON public.drafts USING btree (state, run_id, created_at DESC);



CREATE INDEX drafts_state_idx ON public.drafts USING btree (state);



CREATE INDEX drafts_state_platform_idx ON public.drafts USING btree (state, platform_id, created_at DESC);



CREATE INDEX drafts_state_run_idx ON public.drafts USING btree (state, run_id);



CREATE INDEX drafts_variant_group_idx ON public.drafts USING btree (variant_group_id);



CREATE UNIQUE INDEX extension_devices_token_hash_unique ON public.extension_devices USING btree (token_hash);



CREATE INDEX keyword_watches_campaign_idx ON public.keyword_watches USING btree (campaign_id, is_active);



CREATE INDEX keyword_watches_project_idx ON public.keyword_watches USING btree (project_id, is_active);



CREATE UNIQUE INDEX memberships_org_user_unique ON public.memberships USING btree (organization_id, user_id);



CREATE INDEX messages_account_target_idx ON public.contact_history USING btree (account_handle, target_user);



CREATE INDEX messages_contact_idx ON public.messages USING btree (contact_id, created_at_platform);



CREATE UNIQUE INDEX messages_platform_message_unique ON public.messages USING btree (platform_id, platform_message_id);



CREATE INDEX notifications_unread_idx ON public.notifications USING btree (read_at, created_at DESC);



CREATE INDEX org_invites_org_idx ON public.org_invites USING btree (organization_id);



CREATE INDEX project_insights_project_idx ON public.project_insights USING btree (project_id, generated_at);



CREATE INDEX projects_org_idx ON public.projects USING btree (organization_id);



CREATE INDEX run_events_kind_created_idx ON public.run_events USING btree (kind, created_at);



CREATE INDEX run_events_run_idx ON public.run_events USING btree (run_id, seq);



CREATE UNIQUE INDEX runs_campaign_scheduled_for_unique ON public.runs USING btree (campaign_id, scheduled_for) WHERE ((scheduled_for IS NOT NULL) AND (campaign_id IS NOT NULL));



CREATE INDEX runs_campaign_started_idx ON public.runs USING btree (campaign_id, started_at DESC);



CREATE UNIQUE INDEX runs_one_running_per_campaign ON public.runs USING btree (campaign_id) WHERE (status = 'running'::text);



CREATE INDEX runs_project_kind_idx ON public.runs USING btree (project_id, kind, started_at DESC);



CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);



CREATE INDEX templates_project_kind_idx ON public.templates USING btree (project_id, kind, is_active);



CREATE INDEX webhook_deliveries_due_idx ON public.webhook_deliveries USING btree (status, next_attempt_at);



CREATE INDEX webhook_deliveries_recent_idx ON public.webhook_deliveries USING btree (created_at DESC);



ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_platform_id_platforms_id_fk FOREIGN KEY (platform_id) REFERENCES public.platforms(id);



ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.blocklist
    ADD CONSTRAINT blocklist_platform_id_platforms_id_fk FOREIGN KEY (platform_id) REFERENCES public.platforms(id);



ALTER TABLE ONLY public.blocklist
    ADD CONSTRAINT blocklist_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.campaign_recommendations
    ADD CONSTRAINT campaign_recommendations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_platform_id_platforms_id_fk FOREIGN KEY (platform_id) REFERENCES public.platforms(id);



ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.contact_history
    ADD CONSTRAINT contact_history_draft_id_drafts_id_fk FOREIGN KEY (draft_id) REFERENCES public.drafts(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.contact_history
    ADD CONSTRAINT contact_history_platform_id_platforms_id_fk FOREIGN KEY (platform_id) REFERENCES public.platforms(id);



ALTER TABLE ONLY public.draft_events
    ADD CONSTRAINT draft_events_draft_id_drafts_id_fk FOREIGN KEY (draft_id) REFERENCES public.drafts(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.draft_regeneration_hints
    ADD CONSTRAINT draft_regeneration_hints_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.drafts(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);



ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_drafting_run_id_fkey FOREIGN KEY (drafting_run_id) REFERENCES public.runs(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_platform_id_platforms_id_fk FOREIGN KEY (platform_id) REFERENCES public.platforms(id);



ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_regenerating_run_id_fkey FOREIGN KEY (regenerating_run_id) REFERENCES public.runs(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.extension_devices
    ADD CONSTRAINT extension_devices_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.extension_pairings
    ADD CONSTRAINT extension_pairings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.keyword_watches
    ADD CONSTRAINT keyword_watches_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.keyword_watches
    ADD CONSTRAINT keyword_watches_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contact_history(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.drafts(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_platform_id_fkey FOREIGN KEY (platform_id) REFERENCES public.platforms(id);



ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.project_insights
    ADD CONSTRAINT project_insights_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_campaign_id_campaigns_id_fk FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.staging_scout_candidates
    ADD CONSTRAINT staging_scout_candidates_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.templates
    ADD CONSTRAINT templates_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;




