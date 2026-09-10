import type { Dict } from './types.js';

export const en = {
  'app.name': 'Pitchbox',
  'app.tagline': 'Outreach companion',

  'nav.dashboard': 'Dashboard',
  'nav.activity': 'Activity',
  'nav.settings': 'Settings',

  'dashboard.connection.title': 'Connection',
  'dashboard.connection.connected': 'Connected',
  'dashboard.connection.disconnected': 'Not connected',
  'dashboard.connection.pair': 'Pair with this tab',
  'dashboard.connection.pair-another': 'Pair with another tab',
  'dashboard.connection.disconnect': 'Disconnect',
  'dashboard.connection.handshake-ago': 'handshake {ago}',
  'dashboard.connection.sync-ago': 'sync {ago}',
  'dashboard.connection.default-hint': 'Using a pairing code instead? It defaults to {url}.',
  'dashboard.connection.add-toggle': 'Add with a pairing code',
  'dashboard.connection.add-hint':
    'Get a code from your dashboard (Settings -> Integrations), then connect without opening that tab.',
  'dashboard.connection.backend-placeholder': 'https://app.pitchbox.app',
  'dashboard.connection.code-placeholder': 'Pairing code',
  'dashboard.connection.connect': 'Connect',
  'dashboard.connection.connecting': 'Connecting...',
  'dashboard.connection.cancel': 'Cancel',
  'dashboard.connection.bad-url': 'Enter a valid backend URL',
  'dashboard.connection.code-required': 'Enter the pairing code',
  'dashboard.connection.perm-denied': 'Permission denied for {host}',
  'dashboard.connection.perm-request-failed': 'Could not request permission for {host}. Try again.',
  'dashboard.connection.pair-failed': 'Pairing failed: {reason}',
  'dashboard.connection.pairing': 'Pairing...',
  'dashboard.connection.pair-error-unauthorized':
    "You're not signed in to the dashboard in that tab. Sign in, then try again.",
  'dashboard.connection.pair-error-no-dashboard':
    'No Pitchbox dashboard found in that tab. Open your dashboard, then try again.',
  'dashboard.connection.pair-error-network':
    'Could not reach the dashboard. Check your connection, then try again.',
  'dashboard.connection.pair-error-server':
    'The dashboard returned an unexpected error. Try again in a moment.',
  'dashboard.connection.degraded': 'Needs attention',
  'dashboard.connection.sync-error': 'Sync error',
  'dashboard.connection.test': 'Test connection',
  'dashboard.connection.testing': 'Testing...',
  'dashboard.connection.test-ok': 'Connected - server v{version}',
  'dashboard.connection.test-fail': 'Test failed: {reason}',
  'dashboard.connection.consent-title': 'Share Reddit activity with {host}?',
  'dashboard.connection.consent-body':
    'Every paired backend receives the full stream of Reddit DM, comment, and chat message bodies this extension captures.',
  'dashboard.connection.consent-confirm': 'Confirm & pair',
  'dashboard.connection.consent-review-title': 'Review what {host} receives',
  'dashboard.connection.consent-ack': 'Got it',

  'dashboard.sync.title': 'Sync',
  'dashboard.sync.now': 'Sync now',
  'dashboard.sync.syncing': 'Syncing…',
  'dashboard.sync.last': 'Last run: {ago}',
  'dashboard.sync.next': 'Next run: in {mins} min',
  'dashboard.sync.counters': '{inserted} new · {replied} replied',
  'dashboard.sync.never': 'never',

  'dashboard.token.title': 'Reddit token',
  'dashboard.token.ok': 'Reddit Chat token captured.',
  'dashboard.token.unauthorized':
    'Reddit Chat sync paused. Open reddit.com so the extension can capture a fresh token.',
  'dashboard.token.unknown': 'No Reddit Chat token yet. Open reddit.com to capture one.',
  'dashboard.token.open-reddit': 'Open reddit.com',

  'activity.title': 'Activity',
  'activity.empty': 'No activity yet.',
  'activity.filter.level': 'Level',
  'activity.filter.source': 'Source',
  'activity.filter.search': 'Search messages…',
  'activity.actions.clear': 'Clear',
  'activity.actions.export': 'Export JSON',
  'activity.actions.export-done': 'Exported {n} events.',
  // #452: the row action labels resolveActivityAction's action kinds
  // render as. 'open-reddit' has no entry of its own - it reuses
  // dashboard.token.open-reddit, the exact button Dashboard already ships.
  'activity.actions.retry-sync': 'Retry sync now',
  'activity.actions.regrant-linkedin': 'Turn LinkedIn access back on',
  'activity.actions.open-backend': 'Open backend',
  'activity.actions.open-assist-settings': 'Open assist settings',
  'activity.retention-notice':
    '{count} entries older than {oldest} were dropped to stay within the {cap}-entry limit.',
  'activity.clear.confirm-title': 'Clear activity log?',
  'activity.clear.confirm-body': 'All log entries will be removed. This cannot be undone.',
  'activity.clear.confirm-ok': 'Clear log',
  'activity.clear.cancel': 'Cancel',

  'activity.dm-sync.ok': 'Reddit inbox sync - {inserted} new, {replied} replied.',
  'activity.dm-sync.unauthorized': 'Reddit inbox sync paused - please log in to reddit.com.',
  'activity.dm-sync.error': 'Reddit inbox sync failed: {reason}',
  'activity.dm-sync.device-revoked':
    'A paired backend rejected this device (revoked). Re-pair from Settings > Integrations.',
  'activity.chat-sync.ok': 'Reddit Chat sync - {messages} messages, {inserted} new.',
  'activity.chat-sync.unauthorized': 'Reddit Chat sync paused - Matrix token expired.',
  'activity.chat-sync.error': 'Reddit Chat sync failed: {reason}',
  'activity.chat-sync.timeline-truncated':
    'Reddit Chat room {roomId} returned more messages than one sync could fetch; some may be delayed.',
  'activity.chat-sync.cursor-skip':
    'Reddit Chat sync advanced past an undelivered batch after {cycles} retries to a stuck backend.',
  'activity.pairing.added': 'Paired with {host}.',
  'activity.pairing.removed': 'Disconnected {host}.',
  'activity.matrix-token.captured': 'Captured Reddit Chat token.',
  'activity.matrix-token.cleared': 'Cleared Reddit Chat token.',
  'activity.reddit-action.dm-sent': 'Sent DM for draft {draftId}.',
  'activity.reddit-action.comment-sent': 'Posted comment for draft {draftId}.',
  'activity.reddit-action.submit-sent': 'Posted submission for draft {draftId}.',
  'activity.reddit-action.fail': 'Backend flip failed for draft {draftId}: {reason}',
  'activity.reddit-action.submit-button-not-found':
    'Could not find the Reddit submit button for draft {draftId}.',
  'activity.reddit-action.submit-no-t3':
    'Reddit submission for draft {draftId} navigated away without a post id.',
  'activity.reddit-action.submit-poll-timeout':
    'Timed out waiting for the Reddit submission for draft {draftId} to complete.',
  'activity.reddit-action.comment-box-missing':
    'Could not find the comment box for draft {draftId}; it was not pre-filled.',
  'activity.reddit-action.comment-submit-not-found':
    'Could not find the comment submit button for draft {draftId} within 15s; posting will not be tracked automatically.',
  'activity.reddit-action.comment-confirm-timeout':
    'Could not confirm draft {draftId} was posted within 20s after clicking submit; check its status manually.',
  'activity.reddit-action.send-button-not-found':
    'Gave up waiting for the DM send button for draft {draftId}.',
  'activity.reddit-action.send-poll-timeout': 'Gave up confirming draft {draftId} was sent.',
  'activity.reddit-action.compose-box-missing':
    'Could not find the DM compose box for draft {draftId}.',
  'activity.reddit-action.account-handle-unresolved':
    'Could not determine your Reddit account for draft {draftId}; reply matching may be less accurate.',
  'activity.reddit-action.comment-id-unresolved':
    'Could not read the id of the comment posted for draft {draftId}; replies to it will not be detected.',
  'activity.reddit-action.undeliverable': 'Draft {draftId} is undeliverable: {reason}',
  'activity.linkedin-action.comment-sent': 'Posted comment for draft {draftId}.',
  'activity.linkedin-action.fail': 'Backend flip failed for draft {draftId}: {reason}',
  'activity.linkedin-action.composer-missing':
    'Could not find the LinkedIn comment composer for draft {draftId}; it was not offered.',
  'activity.linkedin-action.comment-submit-not-found':
    'Could not find the LinkedIn comment submit button for draft {draftId} within 15s; posting will not be tracked automatically.',
  'activity.linkedin-action.comment-confirm-timeout':
    'Could not confirm draft {draftId} was posted within 20s after clicking submit; check its status manually.',
  'activity.linkedin-action.assist-composer-not-found':
    'Could not find the LinkedIn comment composer; the suggestion assistant was not offered.',
  'activity.linkedin-action.suggestion-refused': 'LinkedIn assist suggestion refused: {reason}',
  // #382: a `done` event can arrive with no draft - either the model chose
  // not to write one (`skipped: true`) or it ignored the envelope format
  // (`skipped: false`, the fail-safe: no marker means no draft). Neither is
  // a refusal, so it gets its own message rather than reusing that key.
  'activity.linkedin-action.suggestion-no-draft':
    'LinkedIn assist produced no draft to insert (skipped: {skipped}).',
  'activity.linkedin-action.suggestion-inserted':
    'Inserted an accepted suggestion into the LinkedIn composer (ledger id {id}).',
  // #449: mounted purely from the composer click (no card selector on the
  // critical path), so this is the one signal that the delegated listener
  // actually fired and where on LinkedIn it fired - `card` names whether a
  // post card could be scoped around the composer, not whether the mount
  // itself succeeded.
  'activity.linkedin-action.assist-mounted':
    'Comment assist opened on the {pageKind} page, with the post card {card}.',
  'activity.linkedin-dom.selector-miss':
    'LinkedIn selector "{selector}" is not matching on the {pageKind} page ({misses} misses, {matches} matches) - this reading may be stale or missing.',
  'activity.linkedin-collector.batch-sent':
    'LinkedIn observations sent - {inserted} new, {duplicates} duplicate, {dropped} dropped.',
  'activity.linkedin-collector.batch-failed': 'LinkedIn observation batch failed: {reason}',
  'activity.linkedin-collector.stopped': 'LinkedIn observation collector stopped: {reason}',
  // Pending project-source fill (#436, spike #435's "Plane 3"): a
  // linkedin_post/linkedin_profile source filled from the page the human
  // actually opened.
  'activity.linkedin-collector.source-filled': 'Filled a pending {kind} project source.',
  'activity.linkedin-collector.source-fill-failed': 'LinkedIn project source fill failed: {reason}',
  // Passive operator-profile/voice-sample capture (Persona, decision 3): the
  // handle/headline/experience read off a profile page the human opened, and
  // recent posts read the same way as voice samples.
  'activity.linkedin-collector.profile-captured': 'Captured your LinkedIn profile.',
  // LOR-180: a second refusal reason (implausible_name) joined
  // not_your_profile, so this interpolates {reason} rather than naming one
  // outcome - same posture as suggestion-refused above.
  'activity.linkedin-collector.profile-refused': 'LinkedIn profile capture skipped: {reason}',
  'activity.linkedin-collector.profile-failed': 'LinkedIn profile capture failed: {reason}',
  'activity.linkedin-collector.voice-samples-captured':
    'Captured {count} new post(s) as voice samples.',
  'activity.settings.changed': 'Settings updated.',
  'activity.system.boot': 'Service worker started.',
  'activity.system.alarms-applied': 'Alarms re-applied ({interval} min).',
  'activity.system.upgraded': 'Extension upgraded {from} → {to}.',
  'activity.system.installed': 'Extension installed.',

  'settings.appearance.title': 'Appearance',
  'settings.appearance.theme': 'Theme',
  'settings.appearance.theme.light': 'Light',
  'settings.appearance.theme.dark': 'Dark',
  'settings.appearance.theme.system': 'System',
  'settings.appearance.density': 'Density',
  'settings.appearance.density.compact': 'Compact',
  'settings.appearance.density.comfortable': 'Comfortable',

  'settings.language.title': 'Language',
  'settings.language.locale': 'Locale',

  'settings.sync.title': 'Sync schedule',
  'settings.sync.interval': 'Poller interval',
  'settings.sync.interval.5': 'Every 5 minutes',
  'settings.sync.interval.10': 'Every 10 minutes',
  'settings.sync.interval.15': 'Every 15 minutes',
  'settings.sync.interval.30': 'Every 30 minutes',
  'settings.sync.legacy': 'Legacy inbox poller',
  'settings.sync.chat': 'Reddit Chat poller',

  'settings.data.title': 'Data',
  'settings.data.clear-log': 'Clear activity log',
  'settings.data.reset': 'Reset extension',
  'settings.data.reset.confirm-title': 'Reset extension?',
  'settings.data.reset.confirm-body':
    'All pairings, settings and the activity log will be removed.',
  'settings.data.reset.confirm-ok': 'Reset',

  'settings.about.title': 'About',
  'settings.about.version': 'Version',
  'settings.about.github': 'GitHub',
  'settings.about.docs': 'Documentation',

  // #399/#400: home states what Pitchbox can do, not what Chrome was asked
  // for (D22). Chrome's own bubble already carries the permission language.
  'home.access.on': 'LinkedIn access: on',
  'home.access.off': 'LinkedIn access: off',
  'home.access.on-detail': 'The assistant can read the post you are on and suggest a comment.',
  'home.access.off-detail': 'Turn it on and the assistant works inside LinkedIn itself.',
  'home.access.turn-on': 'Turn on',
  'home.access.turn-off': 'Turn off',
  'home.access.denied': 'Chrome did not grant access. You can ask again anytime.',
  'home.access.request-failed': 'Could not ask Chrome for LinkedIn access. Try again.',

  // #569: image capture is its own opt-in, deliberately never folded into
  // home.access above (Main's call, 2026-09-09) - see
  // ImageCaptureAccessRow.svelte's own doc comment for why. The off-detail
  // line says plainly that Chrome will ask for every site, not just
  // LinkedIn, and why: captureVisibleTab is a browser-level capture of the
  // visible tab, so Chrome will not scope it to one origin.
  'home.image-access.on': 'Image-aware suggestions: on',
  'home.image-access.off': 'Image-aware suggestions: off',
  'home.image-access.on-detail':
    'The assistant can look at the picture in a post before it suggests a comment.',
  'home.image-access.off-detail':
    'Chrome has no way to capture just LinkedIn - turning this on means answering Chrome\'s own "all sites" prompt, not a LinkedIn-only one. Skip it and the assistant just says it cannot see the image.',
  'home.image-access.turn-on': 'Turn on',
  'home.image-access.turn-off': 'Turn off',
  'home.image-access.denied': 'Chrome did not grant access. You can ask again anytime.',
  'home.image-access.request-failed': 'Could not ask Chrome for access. Try again.',

  // The state line at the top of home, one per state lib/home-state.ts can
  // derive. Every line names the state in words; every detail names what set
  // it (D21).
  'home.state.not-paired': 'Not paired',
  'home.state.not-paired-hint': 'Open your Pitchbox dashboard, sign in, then pair from that tab.',
  'home.state.ready': 'Ready',
  'home.state.ready-linkedin': 'Ready on LinkedIn',
  'home.state.linkedin-off': 'LinkedIn access is off, so nothing runs inside LinkedIn yet.',
  'home.state.pending': 'Not synced yet',
  'home.state.pending-detail': 'Paired with {host}. The first sync has not run yet.',
  'home.state.degraded': 'Needs attention',
  'home.state.sync-error': 'Sync stopped',
  'home.state.channel-chat': 'Reddit Chat is not syncing on {host}.',
  'home.state.channel-legacy': 'Reddit messages are not syncing on {host}.',
  'home.state.stale': 'No sync report from {host} in the last 45 minutes.',
  'home.state.access-revoked': 'LinkedIn access was removed',
  'home.state.access-revoked-detail':
    'Chrome no longer grants it, so the in-page assistant is not running. Turn it back on below.',
  'home.sync.not-scheduled': 'No sync scheduled',

  'time.never': 'never',
  'time.seconds-ago': '{n}s ago',
  'time.minutes-ago': '{n}m ago',
  'time.hours-ago': '{n}h ago',
  'time.days-ago': '{n}d ago',

  'activity.level.all': 'All',
  'activity.level.info': 'Info',
  'activity.level.warn': 'Warn',
  'activity.level.error': 'Error',

  'activity.source.all': 'All',
  'activity.source.pairing': 'Pairing',
  'activity.source.dm-sync': 'DM sync',
  'activity.source.chat-sync': 'Chat sync',
  'activity.source.matrix-token': 'Matrix token',
  'activity.source.reddit-action': 'Reddit action',
  'activity.source.settings': 'Settings',
  'activity.source.system': 'System',

  'dashboard.connection.no-active-tab': 'No active tab',

  // #556: the plan readout PairingList.svelte shows per paired backend,
  // display only - the server refuses regardless of what this says
  // (docs/design/DECISIONS.md D28). `plan-remaining-low` is the same fact
  // as `plan-remaining`, worded to stand out once suggestionsRemaining
  // drops to the 80%-used warning threshold #557 already established
  // elsewhere in this product.
  'dashboard.connection.plan-remaining':
    '{plan} plan: {remaining} of {limit} suggestions left this period',
  'dashboard.connection.plan-remaining-low':
    '{plan} plan: only {remaining} of {limit} suggestions left this period',
  'dashboard.connection.plan-unlimited': '{plan} plan: unlimited suggestions',
  'dashboard.connection.plan-read-only': '{plan} plan: read-only until the payment issue is fixed',

  // In-page panel chrome. The wordmark is the product name, so it is not
  // translated; everything else on this surface is.
  'panel.title': 'Pitchbox',
  'panel.close': 'Close',

  // In-page LinkedIn comment assist (LI-17, #314): the panel that offers a
  // suggested comment next to LinkedIn's own composer. Shared with #315's
  // post-composer assist wherever a key names no particular kind.
  'assist.comment.resting.hint': 'Get a Pitchbox-suggested reply for this post.',
  'assist.comment.resting.cta': 'Suggest a comment',
  'assist.status.reading': 'Reading the post…',
  'assist.status.writing': 'Writing…',
  // #573: the loop's own step narration - see
  // content/shared/assist-status.ts's own doc comment for how a tool name
  // becomes one of these clauses and how several running at once combine.
  // Lowercase and without a leading capital: `describeStatus` capitalises
  // whichever one (or combination) actually renders.
  'assist.status.step.read_thread': 'reading the thread',
  'assist.status.step.look_at_image': 'looking at the image',
  'assist.status.step.author_history': 'checking what you have said to them before',
  'assist.status.step.operator_voice': 'finding how you have written about this',
  'assist.status.step.project_knowledge': 'checking what it knows about this project',
  'assist.status.step.my_prior_takes': 'checking your prior takes',
  'assist.status.step.check_style': 'checking the style',
  'assist.status.step.unknown': 'still working on it',
  // Past the 35s soft budget (docs/design/in-page-agent.md section 2, D27).
  'assist.status.slow': 'This is taking longer than usual.',
  // A genuine early stop at the 90s hard ceiling with a draft already in
  // hand - said plainly rather than surfaced as an error (D27).
  'assist.status.budget_exhausted': 'Answered with what it had time to gather.',
  'assist.comment.ready.label': 'Suggested comment (editable)',
  'assist.action.accept': 'Insert',
  'assist.action.retry': 'Try again',
  // #409: retune this one draft in an explicit direction, without writing
  // the org's tone setting. Shared between the comment and post panels, same
  // as `assist.action.accept`/`assist.action.retry` above.
  'assist.action.retune.drier': 'Drier',
  'assist.action.retune.warmer': 'Warmer',
  'assist.action.retune.shorter': 'Shorter',
  // Shown only when a retune would replace a human edit still in the
  // textarea - it never fires from `ready`, where there is nothing to lose.
  'assist.retune.confirm.hint': 'This replaces what you edited.',
  'assist.retune.confirm.accept': 'Retune anyway',
  'assist.retune.confirm.cancel': 'Keep editing',
  // Collapsed disclosure toggle that reveals the model's own reasoning
  // behind the draft above - a short clickable label, not a sentence, in
  // the product's voice rather than the model's.
  'assist.comment.why': 'Why this angle',
  'assist.comment.accepting': 'Saving…',
  'assist.comment.inserted.title': 'Inserted',
  'assist.comment.inserted.hint': "Press LinkedIn's own Comment button to send it.",
  // In-page LinkedIn post composer assist (LI-18, #315): same shape as the
  // comment assist above, offering a post rather than a comment. No
  // `resting`/`ready` subject: the suggestion is the operator's own voice,
  // not a reply to anyone.
  'assist.post.resting.hint': 'Get a Pitchbox-suggested post for your network.',
  'assist.post.resting.cta': 'Suggest a post',
  'assist.post.ready.label': 'Suggested post (editable)',
  'assist.post.accepting': 'Saving…',
  'assist.post.inserted.title': 'Inserted',
  'assist.post.inserted.hint': "Press LinkedIn's own Post button to send it.",
  // #521 retired the per-account draft quota (`accounts`, `checkQuota`) this
  // used to precondition on, and with it the `quota_exhausted`/`no_account`
  // refusals - what bounds a suggestion now is the per-device/per-org rate
  // limiter and the plan's own suggestions ceiling. What remains: the assist
  // gate's own reasons, the accept path's own three, and four this client
  // detects itself (backend_unreachable, selector health, a mid-stream
  // generation failure, and a dead extension context) - each real, each
  // with its own remedy, never a generic failure.
  'assist.refusal.assist_disabled': 'The Pitchbox assistant is turned off for this workspace.',
  'assist.refusal.kill_switch': 'An admin stopped the assistant.',
  'assist.refusal.project_not_bound': 'No project is bound to the assistant yet.',
  'assist.refusal.blocked': 'This person is on the blocklist.',
  'assist.refusal.uncontactable': 'This person was marked uncontactable.',
  'assist.refusal.recently_contacted': 'Already contacted recently, so this is being skipped.',
  'assist.refusal.backend_unreachable': 'Could not reach the Pitchbox backend.',
  'assist.refusal.selector_health_degraded':
    "LinkedIn's layout changed and Pitchbox could not read this post reliably.",
  'assist.refusal.generation_failed': 'Something went wrong while writing the suggestion.',
  // #556: the plan's own ceiling and a failed payment past its grace
  // window - distinct from each other, so the panel can say which one
  // stopped it, each with a link that opens `/settings/billing` in a new
  // tab (D28).
  'assist.refusal.plan_limit_reached': "Your plan's suggestion limit for this period is used up.",
  'assist.refusal.plan_payment_required': 'Fix your payment to keep using the assistant.',
  'assist.action.open_billing': 'Open billing settings',
  // The content script's own extension context dies on a reload/update of
  // the extension itself while this tab stayed open - every message.send
  // to the background worker then fails the same way `backend_unreachable`
  // does, but the backend is fine; reusing that string would blame the
  // wrong thing and point at a retry that cannot work. Only a page reload
  // re-injects a live content script.
  'assist.refusal.extension_reloaded':
    'Pitchbox was reloaded or updated - reload this page to reconnect.',
  'assist.refusal.unknown': 'The assistant refused this request ({reason}).',
  // Post-only (#523): a post suggestion has no post of its own to ground
  // in, so unlike every other kind it still needs a real project even
  // though a project is optional for the plane overall.
  'assist.refusal.project_required': 'Bind a project to the assistant to suggest a post.',
  // Post-only: the observation buffer this suggestion grounds in (#315) had
  // nothing recent enough to draft from.
  'assist.refusal.no_recent_activity':
    'Nothing recent to draft a post from yet. Browse your network for a bit, then try again.',
  // #382: "no marker means no draft" rendered honestly - two distinct causes,
  // two distinct messages, never an insertable blob of reasoning. #438: the
  // model's own refusal prose used to render verbatim here; these are now a
  // named state (title) plus one concrete next action (hint), same shape as
  // `assist.comment.inserted.*` above. `skipped` is the model's own call
  // that this post is not worth a comment - not a failure, so it must not
  // read like one. `malformed` is a `done` event that ignored the required
  // envelope - that is Pitchbox's bug, not the post's, so it owns the
  // failure instead of describing it.
  'assist.comment.no_draft.skipped.title': 'No suggestion for this post',
  'assist.comment.no_draft.skipped.hint': 'Try again if this post deserves a second look.',
  'assist.comment.no_draft.malformed.title': 'Could not generate a suggestion',
  'assist.comment.no_draft.malformed.hint': 'Try again in a moment.',
  // Same disclosure toggle as `assist.comment.why` above, but under the
  // no-draft state: it asks about the decision to decline rather than
  // about a drafted angle.
  'assist.comment.why_skipped': 'Why no suggestion',
  'assist.post.no_draft.skipped': 'The assistant decided not to suggest a post right now.',
  'assist.post.no_draft.unstructured': 'The assistant did not produce a post to insert.',

  // Language names are endonyms (each language's own name for itself) and
  // are intentionally identical across every locale dictionary; a language
  // picker must stay readable to someone who cannot read the current UI
  // language yet.
  'settings.language.option.en': 'English',
  'settings.language.option.it': 'Italiano',
} satisfies Dict;
