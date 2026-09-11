import type { Dict } from '../types.js';

/**
 * LOR-263 part two: the settings area (rail + its ten flat routes,
 * `settings/billing`, `settings/language`, and the instance-admin subtree).
 * `settings.onboarding.*` stays in `dict-en.ts`/`dict-it.ts` - part one's
 * keys, still read by `settings/onboarding/+page.svelte`, which nobody else
 * in this wave owns either but which shipped before this per-area
 * convention existed.
 */
export const settingsEn = {
  'settings.rail.aria-label': 'Settings sections',
  'settings.rail.section-label': 'Settings',
  'settings.rail.admin-section-label': 'Instance admin',
  'settings.nav.general': 'General',
  'settings.nav.onboarding': 'Onboarding',
  'settings.nav.runners': 'Agent runners',
  'settings.nav.extension': 'Browser extension',
  'settings.nav.quota': 'Quota',
  'settings.nav.password': 'Password',
  'settings.nav.language': 'Language',
  'settings.nav.linkedin-assist': 'LinkedIn assist',
  'settings.nav.organization': 'Organization',
  'settings.nav.billing': 'Billing',
  'settings.nav.retention': 'Retention',
  'settings.nav.security': 'Security',
  'settings.nav.admin': 'Instance admin',

  'settings.general.seo-title': 'Settings - General',
  'settings.general.seo-description': 'Daemon status and dashboard appearance.',
  'settings.general.title': 'General',
  'settings.general.description': 'Daemon health and dashboard appearance.',
  'settings.general.daemon.title': 'Daemon',
  'settings.general.daemon.description':
    'The daemon wakes up on schedule, triggers campaigns that have a cron expression, and polls sent DMs for replies.',
  'settings.general.daemon.admin-required-title': 'Instance admin access required',
  'settings.general.daemon.admin-required-description':
    "Daemon health describes the whole deployment, not any one organization, so it's visible to the instance admin only.",
  'settings.general.daemon.unavailable-title': 'Status unavailable',
  'settings.general.daemon.unavailable-description':
    'The status endpoint could not be read, so this says nothing about the daemon itself. If your session expired, sign in again and reload.',
  'settings.general.daemon.not-running-title': 'Not running',
  'settings.general.daemon.not-running-description': 'Start it from the repo root with',
  'settings.general.daemon.age-seconds': '{n}s ago',
  'settings.general.daemon.age-minutes': '{n}m ago',
  'settings.general.daemon.age-hours': '{n}h ago',
  'settings.general.appearance.title': 'Appearance',
  'settings.general.appearance.theme-label': 'Theme',
  'settings.general.appearance.theme-description':
    'Follow system or pick light or dark explicitly.',
  'settings.general.appearance.theme-system': 'System',
  'settings.general.appearance.theme-light': 'Light',
  'settings.general.appearance.theme-dark': 'Dark',

  'settings.runners.seo-title': 'Settings - Agent runners',
  'settings.runners.seo-description': 'Agent runner detection and configuration.',
  'settings.runners.title': 'Agent runners',
  'settings.runners.description':
    'Detected agent runners, their configuration, and the org default.',
  'settings.runners.admin-required-title': 'Admin access required',
  'settings.runners.admin-required-description':
    'Runner configuration is visible to org admins and owners. Ask an admin if you need to check runner availability.',
  'settings.runners.card.description':
    'Detected by probing each runner CLI at startup. Re-detect after installing or upgrading.',
  'settings.runners.card.redetect': 'Re-detect',
  'settings.runners.card.error-admin-required': 'You need admin access for that',
  'settings.runners.card.error-redetect-failed': 'Re-detection failed',
  'settings.runners.card.success-redetected': 'Runners re-detected',
  'settings.runners.card.error-set-default-failed': 'Failed to set default',
  'settings.runners.card.success-set-default': '{slug} is now the default runner',
  'settings.runners.card.empty-title': 'No agent runner installed',
  'settings.runners.card.empty-install-lead': 'Install one of the supported CLIs - e.g.',
  'settings.runners.card.empty-install-tail': '- and click',
  'settings.runners.card.default-badge': 'default',
  'settings.runners.card.not-available-yet': 'Not available in this build yet.',
  'settings.runners.card.set-default': 'Set as default',
  'settings.runners.card.field-cli-default-option': 'CLI default',
  'settings.runners.card.field-custom-placeholder': 'Custom value (overrides selector above)',
  'settings.runners.card.field-default-placeholder': 'default',
  'settings.runners.card.save-config': 'Save config',
  'settings.runners.card.save-failed': 'Save failed',
  'settings.runners.card.save-success': 'Runner config saved',

  'settings.extension.seo-title': 'Settings - Browser extension',
  'settings.extension.seo-description': 'Pair and manage the Pitchbox browser extension.',
  'settings.extension.title': 'Browser extension',
  'settings.extension.description':
    'Pair the Pitchbox Chrome extension with this dashboard and manage paired devices.',
  'settings.extension.card.title': 'Browser extension',
  'settings.extension.card.description-lead':
    'Pairs the Pitchbox Chrome extension with this dashboard. The extension lives in a persistent side panel: it auto-flips drafts to',
  'settings.extension.card.description-tail':
    "when you submit on Reddit, polls Reddit inbox + Chat for replies, and surfaces every operation in a real-time activity log. On LinkedIn, where polling is off-limits, reply and message detection is passive: a reply only reaches this dashboard once you open the post, your notifications or your messaging yourself, so it can lag well behind Reddit's.",
  'settings.extension.card.pair-heading': 'Pair this dashboard',
  'settings.extension.card.pair-step-1':
    'Click the Pitchbox icon in the Chrome toolbar to open the side panel.',
  'settings.extension.card.pair-step-2-lead': 'Open the',
  'settings.extension.card.pair-step-2-tail': 'tab, then click',
  'settings.extension.card.pair-step-3':
    'Approve the one-time host permission prompt for this origin.',
  'settings.extension.card.pair-footer':
    'The extension reads your session cookie to mint a per-device token automatically. Manage and revoke devices below.',
  'settings.extension.card.install-summary': 'Install the extension',
  'settings.extension.card.install-step-1-lead': 'From the repo root:',
  'settings.extension.card.install-step-2-lead': 'Open',
  'settings.extension.card.install-step-2-tail': ', enable',
  'settings.extension.card.install-step-3-lead': 'Click',
  'settings.extension.card.install-step-3-tail': 'and choose',
  'settings.extension.card.install-step-4':
    'Click the Pitchbox icon to open the side panel, then pair as above.',
  'settings.extension.card.backend-url-lead': "Backend URL (enter this in the extension's",
  'settings.extension.card.backend-url-tail': 'form, or use a pairing code):',

  'settings.extension.devices.pairing-title': 'Pairing code',
  'settings.extension.devices.pairing-description-lead':
    "Generate a one-time code to pair a device that is not signed into this dashboard. Enter it in the extension's",
  'settings.extension.devices.pairing-description-tail': 'form. Codes expire after 10 minutes.',
  'settings.extension.devices.copy-aria-label': 'Copy pairing code',
  'settings.extension.devices.code-expired-title': 'Code expired',
  'settings.extension.devices.code-expired-description': 'Generate a new one below.',
  'settings.extension.devices.generate-code': 'Generate pairing code',
  'settings.extension.devices.paired-devices-title': 'Paired devices',
  'settings.extension.devices.loading': 'Loading devices...',
  'settings.extension.devices.load-error-title': 'Could not load devices',
  'settings.extension.devices.retry': 'Retry',
  'settings.extension.devices.empty-title': 'No devices yet',
  'settings.extension.devices.empty-description':
    'Pair the extension from a signed-in tab, or with a pairing code above.',
  'settings.extension.devices.revoked-badge': 'Revoked',
  'settings.extension.devices.seen-ago': 'seen {time}',
  'settings.extension.devices.never-seen': 'never seen',
  'settings.extension.devices.revoke': 'Revoke',
  'settings.extension.devices.device-revoked': 'Device revoked',
  'settings.extension.devices.error-admin-required': 'You need admin access for that',
  'settings.extension.devices.error-revoke-failed': 'Could not revoke the device',
  'settings.extension.devices.error-generate-failed': 'Could not generate a pairing code',
  'settings.extension.devices.pairing-copied': 'Pairing code copied',
  'settings.extension.devices.copy-failed': 'Could not copy, select the code and copy it manually',
  'settings.extension.devices.age-seconds': '{n}s ago',
  'settings.extension.devices.age-minutes': '{n}m ago',
  'settings.extension.devices.age-hours': '{n}h ago',
  'settings.extension.devices.age-days': '{n}d ago',

  'settings.quota.seo-title': 'Settings - Quota',
  'settings.quota.seo-description': 'Posting quota defaults per platform.',
  'settings.quota.title': 'Quota',
  'settings.quota.description': 'Default posting limits per platform, per day and per week.',
  'settings.quota.admin-required-title': 'Admin access required',
  'settings.quota.admin-required-description':
    'Posting quotas are visible to org admins and owners.',
  'settings.quota.unsaved-changes': 'You have unsaved changes',
  'settings.quota.discard': 'Discard',
  'settings.quota.save': 'Save',
  'settings.quota.success-saved': 'Limits saved',
  'settings.quota.error-admin-required': 'You need admin access for that',
  'settings.quota.error-save-failed': 'Save failed',
  'settings.quota.card.reset-to-defaults': 'Reset to defaults',
  'settings.quota.card.column-kind': 'Kind',
  'settings.quota.card.column-per-day': 'Per day',
  'settings.quota.card.column-per-week': 'Per week',
  'settings.quota.card.kind-dm': 'DMs',
  'settings.quota.card.kind-comment': 'Comments',
  'settings.quota.card.kind-post': 'Posts',
  'settings.quota.card.help-dm':
    "Direct messages. Reddit doesn't publish an official limit; under 15/day is considered low-risk for accounts with organic history.",
  'settings.quota.card.help-comment':
    'Sum of post comments + comment replies. Reddit applies implicit throttling on new accounts.',
  'settings.quota.card.help-post':
    "Published posts. Post-draft generation isn't wired up yet - the limit is here for future use.",

  'settings.password.seo-title': 'Settings - Password',
  'settings.password.seo-description': 'Change your account password.',
  'settings.password.title': 'Password',
  'settings.password.description': 'Change the password for {username}.',
  'settings.password.email-verification-title': 'Email verification',
  'settings.password.verified-badge': 'Verified',
  'settings.password.unverified-badge': 'Unverified',
  'settings.password.unverified-note':
    "- an unverified account can sign in but can't start a run yet.",
  'settings.password.sending': 'Sending…',
  'settings.password.resend-verification': 'Resend verification email',
  'settings.password.change-title': 'Change password',
  'settings.password.change-description':
    'Requires your current password. The new one needs at least 8 characters, same as sign-in. Changing it signs out every other session on your account - this one stays signed in.',
  'settings.password.current-password': 'Current password',
  'settings.password.new-password': 'New password',
  'settings.password.confirm-password': 'Confirm new password',
  'settings.password.success-changed': 'Password changed',
  'settings.password.success-changed-description':
    'Every other session on your account was signed out.',
  'settings.password.error-incorrect': 'Current password is incorrect',
  'settings.password.error-too-many-attempts': 'Too many attempts',
  'settings.password.error-retry-after': 'Try again in {n}s',
  'settings.password.error-change-failed': 'Could not change password',
  'settings.password.verify-already-verified': 'Already verified',
  'settings.password.verify-sent': 'Verification email sent',
  'settings.password.verify-sent-description': 'Check {email}.',
  'settings.password.error-resend-failed': 'Could not resend verification email',

  'settings.security.seo-title': 'Settings - Security',
  'settings.security.seo-description': 'Recent failed logins and account lockout controls.',
  'settings.security.title': 'Security',
  'settings.security.description': 'Recent failed logins and account lockout controls.',
  'settings.security.policy.title': 'Policy',
  'settings.security.policy.description-lead': 'Lockout fires after',
  'settings.security.policy.description-within': 'within',
  'settings.security.policy.description-then': '; attempts then return HTTP 429 for',
  'settings.security.policy.tune-lead': 'Tune via the',
  'settings.security.policy.tune-mid': 'row in',
  'settings.security.policy.attempts.one': '{n} failed attempt',
  'settings.security.policy.attempts.other': '{n} failed attempts',
  'settings.security.policy.minutes.one': '{n} minute',
  'settings.security.policy.minutes.other': '{n} minutes',
  'settings.security.unlock.title': 'Unlock account',
  'settings.security.unlock.description':
    'Clears the rolling failure counter for the given username.',
  'settings.security.unlock.username-placeholder': 'username',
  'settings.security.unlock.error-empty': 'Enter a username first',
  'settings.security.unlock.success.one': 'Cleared {n} failure for {name}',
  'settings.security.unlock.success.other': 'Cleared {n} failures for {name}',
  'settings.security.unlock.error-admin-required': 'You need admin access for that',
  'settings.security.unlock.error-failed': 'Unlock failed',
  'settings.security.recent-failures.title': 'Recent failures',
  'settings.security.recent-failures.description':
    'Last 50 failed login attempts (most recent first).',
  'settings.security.recent-failures.empty-title': 'All quiet',
  'settings.security.recent-failures.empty-description': 'No failed login attempts on record.',
  'settings.security.recent-failures.column-identifier': 'Identifier',
  'settings.security.recent-failures.column-kind': 'Kind',
  'settings.security.recent-failures.column-when': 'When',
  'settings.security.age-seconds': '{n}s ago',
  'settings.security.age-minutes': '{n}m ago',
  'settings.security.age-hours': '{n}h ago',
  'settings.security.age-days': '{n}d ago',

  'settings.retention.seo-title': 'Settings - Retention',
  'settings.retention.seo-description':
    'Configure how long drafts and event logs are kept before pruning.',
  'settings.retention.title': 'Retention',
  'settings.retention.description':
    'How long terminal drafts and event logs are kept before the daemon prunes them.',
  'settings.retention.policy-title': 'Policy',
  'settings.retention.policy-description':
    'Values below {floor} days are clamped to {floor} server-side. Contact history is never pruned by this policy.',
  'settings.retention.field-drafts': 'Drafts (sent / rejected / replied)',
  'settings.retention.field-run-events': 'Run events',
  'settings.retention.field-draft-events': 'Draft events',
  'settings.retention.field-webhook-deliveries': 'Webhook deliveries',
  'settings.retention.save': 'Save',
  'settings.retention.success-saved': 'Retention policy saved',
  'settings.retention.error-invalid-number': 'Invalid number',

  'settings.linkedin-assist.seo-title': 'Settings - LinkedIn assist',
  'settings.linkedin-assist.seo-description':
    'On/off, daily caps and the kill switch for the in-page LinkedIn assistant.',
  'settings.linkedin-assist.title': 'LinkedIn assist',
  'settings.linkedin-assist.description':
    'Controls the in-page assistant on linkedin.com: how much it may send, and a kill switch that applies immediately.',
  'settings.linkedin-assist.kill-switch-banner-title': 'Kill switch is on',
  'settings.linkedin-assist.kill-switch-banner-description':
    'Suggestions and observation collection are stopped for every device in this organization, regardless of the settings below.',
  'settings.linkedin-assist.assist.title': 'Assist',
  'settings.linkedin-assist.assist.description':
    'Off by default. Writes as you, the operator - it decides which of your projects (if any) a suggestion is actually about from the post itself, so there is nothing to bind here.',
  'settings.linkedin-assist.assist.enabled-label': 'Assist enabled',
  'settings.linkedin-assist.assist.collector-enabled-label': 'Observation collector enabled',
  'settings.linkedin-assist.assist.project-label': 'Collector attributes sightings to',
  'settings.linkedin-assist.assist.project-placeholder': 'No project bound',
  'settings.linkedin-assist.assist.project-description':
    "Only used by the observation collector, to file what it scrolls past under one of your projects for that project's own campaigns to draw candidates from. Unrelated to what a suggestion writes about.",
  'settings.linkedin-assist.tone.title': 'Tone',
  'settings.linkedin-assist.tone.description':
    'How a suggestion should sound, by default. The house style outranks every option here, so none of them can ask for the typography Pitchbox never emits, and a tone sent by the extension is ignored: this page and the project page are where it is decided. Any project can override this for itself - open the project and look for Voice - so a product does not have to sound like your personal account.',
  'settings.linkedin-assist.tone.register-label': 'Register',
  'settings.linkedin-assist.tone.custom-label': 'In your own words',
  'settings.linkedin-assist.tone.custom-placeholder':
    'Direct, a bit dry, no enthusiasm I would not say out loud',
  'settings.linkedin-assist.tone.custom-description':
    'Goes into the prompt as you wrote it, up to {max} characters.',
  'settings.linkedin-assist.tone.option-match-room-label': 'Match the room',
  'settings.linkedin-assist.tone.option-match-room-hint':
    "Mixes the post's own register with your voice. The default, and what a person actually does.",
  'settings.linkedin-assist.tone.option-professional-label': 'Professional',
  'settings.linkedin-assist.tone.option-professional-hint':
    'Full sentences, no slang, and no corporate filler either.',
  'settings.linkedin-assist.tone.option-plain-label': 'Plain',
  'settings.linkedin-assist.tone.option-plain-hint': 'Short sentences and ordinary words.',
  'settings.linkedin-assist.tone.option-warm-label': 'Warm',
  'settings.linkedin-assist.tone.option-warm-hint':
    'Addresses the author as a person, without exclamation marks.',
  'settings.linkedin-assist.tone.option-technical-label': 'Technical',
  'settings.linkedin-assist.tone.option-technical-hint':
    'Specific about mechanisms, numbers and tradeoffs.',
  'settings.linkedin-assist.tone.option-custom-label': 'In my own words',
  'settings.linkedin-assist.tone.option-custom-hint': 'Describe the tone yourself, below.',
  'settings.linkedin-assist.caps.title': 'Daily caps',
  'settings.linkedin-assist.caps.description':
    "Can be lowered, never raised past the code ceiling: LinkedIn's velocity monitoring treats a high-volume account as a bot regardless of how carefully it was written.",
  'settings.linkedin-assist.caps.comments-label': 'Comments / day',
  'settings.linkedin-assist.caps.posts-label': 'Posts / day',
  'settings.linkedin-assist.caps.ceiling': 'Ceiling: {n} / day',
  'settings.linkedin-assist.kill-switch.title': 'Kill switch',
  'settings.linkedin-assist.kill-switch.description':
    'Stops both collection and suggestion immediately, on every device, without waiting for the next alarm. Separate from turning assist off: use this for "something is wrong right now", not for routine pausing.',
  'settings.linkedin-assist.kill-switch.engaged-label': 'Kill switch engaged',
  'settings.linkedin-assist.selector-health.title': 'Selector health',
  'settings.linkedin-assist.selector-health.description':
    "Whether the extension can still find LinkedIn's feed, composer and submit controls (LI-6, #303). The failure mode this guards against is silent breakage: an assistant that quietly stops finding posts looks identical to a quiet week.",
  'settings.linkedin-assist.selector-health.empty-title': 'No reports yet',
  'settings.linkedin-assist.selector-health.empty-description':
    'Nothing has been reported by an installed extension. This card will populate once the collector (#302) ships and starts reporting selector health here.',
  'settings.linkedin-assist.unsaved-changes': 'You have unsaved changes',
  'settings.linkedin-assist.discard': 'Discard',
  'settings.linkedin-assist.save': 'Save',
  'settings.linkedin-assist.error-tone-required':
    'Describe the tone you want, or pick one of the named options',
  'settings.linkedin-assist.success-saved': 'LinkedIn assist settings saved',
  'settings.linkedin-assist.error-admin-required': 'You need admin access for that',
  'settings.linkedin-assist.error-save-failed': 'Save failed',
  'settings.organization.seo-title': 'Settings - Organization',
  'settings.organization.seo-description':
    'Organization name, roles, members, invites, and danger zone.',
  'settings.organization.title': 'Organization',
  'settings.organization.description-no-org': 'Your organization settings.',
  'settings.organization.sign-in-prompt':
    'Sign in to see and manage the people in your organization.',
  'settings.organization.auth-off-lead':
    'This instance runs with PITCHBOX_AUTH off, so there are no organizations or membership roles to manage. Set PITCHBOX_AUTH=on in your environment to enable them; see the',
  'settings.organization.auth-off-link': 'authentication docs',
  'settings.organization.auth-off-tail': 'for how to turn it on.',
  'settings.organization.card-title': 'Organization',
  'settings.organization.name-label': 'Name',
  'settings.organization.save': 'Save',
  'settings.organization.cancel': 'Cancel',
  'settings.organization.rename': 'Rename',
  'settings.organization.url-slug-label': 'URL slug',
  'settings.organization.quota-title': 'Quota & budget',
  'settings.organization.quota-description':
    "Cap this organization's cloud-runner spend and concurrency. Leave a field blank for unlimited.",
  'settings.organization.monthly-budget-label': 'Monthly run budget (USD)',
  'settings.organization.max-concurrent-label': 'Max concurrent runs',
  'settings.organization.unlimited': 'Unlimited',
  'settings.organization.month-to-date-label': 'Month-to-date spend',
  'settings.organization.remaining-budget-label': 'Remaining budget',
  'settings.organization.campaign-spend-label': 'Campaign spend',
  'settings.organization.assistant-spend-label': 'Assistant spend',
  'settings.organization.assistant-spend-note': '- LinkedIn suggestions, not campaign runs',
  'settings.organization.roles-title': 'Roles',
  'settings.organization.roles-description': 'What each role can do in this organization.',
  'settings.organization.cannot-prefix': 'Cannot:',
  'settings.organization.role-caps.member-can':
    'Work campaigns and drafts, run agents, manage keyword watches and templates.',
  'settings.organization.role-caps.member-cant':
    'Manage projects, accounts, org settings, or members.',
  'settings.organization.role-caps.admin-can':
    'Everything a member can, plus projects, accounts, deletes, org settings, and members.',
  'settings.organization.role-caps.admin-cant': 'Manage owners or delete the organization.',
  'settings.organization.role-caps.owner-can':
    'Full control: everything an admin can, plus managing owners and deleting the org.',
  'settings.organization.role-hint.member': 'Can view and work in the organization.',
  'settings.organization.role-hint.admin': 'Can also invite people and manage members.',
  'settings.organization.role-hint.owner':
    'Full control, including managing owners and deleting the org.',
  'settings.organization.members-title': 'Members',
  'settings.organization.people-count.one': 'person',
  'settings.organization.people-count.other': 'people',
  'settings.organization.people-in-org': 'in {org}',
  'settings.organization.invite-member': 'Invite member',
  'settings.organization.you-suffix': '(you)',
  'settings.organization.joined-on': 'joined {date}',
  'settings.organization.manage-member': 'Manage {name}',
  'settings.organization.change-role': 'Change role',
  'settings.organization.make-role': 'Make {role}',
  'settings.organization.remove-from-org': 'Remove from organization',
  'settings.organization.pending-invites-title': 'Pending invites',
  'settings.organization.pending-invites-description': 'Links that have not been accepted yet.',
  'settings.organization.no-pending-invites': 'No pending invites.',
  'settings.organization.expires-label': 'expires {time}',
  'settings.organization.expires-soon': 'soon',
  'settings.organization.expires-in-days.one': 'in {n} day',
  'settings.organization.expires-in-days.other': 'in {n} days',
  'settings.organization.copy-link': 'Copy link',
  'settings.organization.revoke': 'Revoke',
  'settings.organization.danger-zone-title': 'Danger zone',
  'settings.organization.leave-org-title': 'Leave organization',
  'settings.organization.leave-org-description': 'Remove yourself from {org}.',
  'settings.organization.leave': 'Leave',
  'settings.organization.delete-org-title': 'Delete organization',
  'settings.organization.delete-org-description':
    'Permanently delete {org} and all its projects, campaigns, and drafts.',
  'settings.organization.delete': 'Delete',
  'settings.organization.invite-dialog-title': 'Invite a member',
  'settings.organization.invite-dialog-description':
    'Pick a role and, if you have it, an email address. It expires in 7 days.',
  'settings.organization.role-label': 'Role',
  'settings.organization.email-optional-label': 'Email (optional)',
  'settings.organization.email-not-configured-note':
    "If mail isn't set up on this deployment, you'll still get a link to share by hand.",
  'settings.organization.invite-link-label': 'Invite link',
  'settings.organization.copy-link-aria': 'Copy link',
  'settings.organization.invite-sent-note':
    "Sent to {email}. If it doesn't arrive, share this link instead.",
  'settings.organization.invite-mail-not-configured':
    "Mail isn't configured on this deployment, so share this link with {email} yourself.",
  'settings.organization.invite-anyone-note-lead': 'Anyone with this link can join as',
  'settings.organization.generate-another': 'Generate another',
  'settings.organization.done': 'Done',
  'settings.organization.send-invite': 'Send invite',
  'settings.organization.generate-link': 'Generate link',
  'settings.organization.delete-dialog-description':
    'This permanently deletes {org} and all its projects, campaigns, and drafts. This cannot be undone.',
  'settings.organization.type-to-confirm-lead': 'Type',
  'settings.organization.type-to-confirm-tail': 'to confirm',
  'settings.organization.invite-link-copied': 'Invite link copied',
  'settings.organization.copy-failed': 'Could not copy, select the link and copy it manually',
  'settings.organization.error-invite-forbidden': 'Only owners and admins can invite people',
  'settings.organization.error-invalid-email': 'Enter a valid email address',
  'settings.organization.error-invite-failed': 'Could not create the invite',
  'settings.organization.invite-sent-to': 'Invite sent to {email}',
  'settings.organization.error-revoke-invite-failed': 'Could not revoke the invite',
  'settings.organization.invite-revoked': 'Invite revoked',
  'settings.organization.error-not-allowed': 'Not allowed',
  'settings.organization.error-change-role-failed': 'Could not change the role',
  'settings.organization.role-updated': 'Role updated',
  'settings.organization.error-remove-member-failed': 'Could not remove the member',
  'settings.organization.member-removed': '{username} removed',
  'settings.organization.error-name-required': 'Enter an organization name',
  'settings.organization.error-admin-required-rename': 'You need admin access to rename',
  'settings.organization.error-rename-failed': 'Could not rename',
  'settings.organization.org-renamed': 'Organization renamed',
  'settings.organization.error-budget-negative': 'Monthly budget cannot be negative',
  'settings.organization.error-cap-negative': 'Max concurrent runs cannot be negative',
  'settings.organization.error-admin-required': 'You need admin access for that',
  'settings.organization.error-quota-save-failed': 'Could not save quota',
  'settings.organization.quota-saved': 'Quota saved',
  'settings.organization.error-cannot-leave': 'Cannot leave',
  'settings.organization.error-leave-failed': 'Could not leave the organization',
  'settings.organization.left-org': 'You left the organization',
  'settings.organization.error-only-owner-deletes': 'Only an owner can delete the organization',
  'settings.organization.error-delete-failed': 'Could not delete the organization',
  'settings.organization.org-deleted': 'Organization deleted',
  'settings.organization.close-dialog-aria': 'Close dialog',
  'settings.organization.remove-member-title': 'Remove member',
  'settings.organization.remove-member-description-lead': 'This removes',
  'settings.organization.remove-member-description-mid':
    'from {org}. They lose access to every project in the organization immediately. Type their username',
  'settings.organization.remove-member-description-tail': 'to confirm.',
  'settings.organization.username-label': 'Username',
  'settings.organization.leave-dialog-description-lead': 'This removes your access to',
  'settings.organization.leave-dialog-description-mid':
    'and everything in it, projects, campaigns, and drafts. You will need a new invite to rejoin. Type the organization name',
  'settings.organization.leave-dialog-description-tail': 'to confirm.',
  'settings.organization.org-name-label': 'Organization name',

  'settings.language.seo-title': 'Settings - Language',
  'settings.language.seo-description': "Choose the dashboard's display language.",
  'settings.language.title': 'Language',
  'settings.language.description':
    'Applies to the dashboard and, on its next handshake, the browser extension - one account setting, not one per surface.',
  'settings.language.display-language-title': 'Display language',
  'settings.language.display-language-description':
    "Signed-out pages keep using your browser's language until you sign in.",
  'settings.language.success-saved': 'Language saved',
  'settings.language.error-save-failed': 'Could not save the language',

  'settings.billing.seo-title': 'Settings - Billing',
  'settings.billing.seo-description':
    'Your plan, what of it is used this period, and how to change it.',
  'settings.billing.title': 'Billing',
  'settings.billing.description':
    'The plan, what of it is used this period, and the two real ways to change it.',
  'settings.billing.self-hosted-title': 'Self-hosted',
  'settings.billing.self-hosted-description':
    'This deployment runs outside the cloud edition, so every limit is unlimited and there is nothing to bill. There is no plan to pick or portal to open here.',
  'settings.billing.read-only-since': 'Account is read-only since {date}',
  'settings.billing.read-only-description':
    'A payment failed and nothing succeeded during the grace period. New runs, suggestions, accepts, projects, campaigns, invites and devices are refused until the payment method is fixed in the portal below.',
  'settings.billing.grace-period-until': 'Payment failed - grace period until {date}',
  'settings.billing.grace-period-description':
    'The plan keeps working normally until then. Update the payment method in the portal below before {date} to avoid going read-only.',
  'settings.billing.granted-badge': 'Granted',
  'settings.billing.granted-description':
    'This plan was granted by an instance admin. It is not billed through Stripe, and does not change from this page.',
  'settings.billing.free-description':
    'No subscription. Free covers a single project on the house.',
  'settings.billing.cancels-on': 'cancels on {date}',
  'settings.billing.renews-on': 'renews on {date}',
  'settings.billing.switches-to': 'switches to {plan} on {date}',
  'settings.billing.per-month': '/ month',
  'settings.billing.or': 'or',
  'settings.billing.per-year': '/ year',
  'settings.billing.monthly': 'Monthly',
  'settings.billing.yearly': 'Yearly',
  'settings.billing.open-customer-portal': 'Open customer portal',
  'settings.billing.portal-note':
    'Change plan, update the payment method, or see invoices in the portal. Nothing here writes a plan directly - the portal and its webhook are the only path.',
  'settings.billing.usage-title': 'Usage this period',
  'settings.billing.usage-description':
    'What the plan meters, measured against its limits. A metric the plan leaves unmetered says unlimited rather than a full bar.',
  'settings.billing.metric-runs': 'Runs',
  'settings.billing.metric-suggestions': 'Suggestions',
  'settings.billing.metric-projects': 'Projects',
  'settings.billing.metric-accounts': 'Connected accounts',
  'settings.billing.metric-seats': 'Seats',
  'settings.billing.metric-devices': 'Paired devices',
  'settings.billing.model-allowance-label': 'Model allowance used',
  'settings.billing.model-allowance-description':
    "How much of this period's model-spend allowance the org has used. Not an invoice line - the portal has those.",
  'settings.billing.unlimited': 'Unlimited',
  'settings.billing.error-checkout-failed': 'Could not start checkout',
  'settings.billing.error-portal-failed': 'Could not open the customer portal',

  'settings.admin.seo-title': 'Settings - Instance admin',
  'settings.admin.seo-description':
    'Instance-wide configuration for the operator of this deployment.',
  'settings.admin.title': 'Instance admin',
  'settings.admin.description':
    'Configuration that belongs to the operator of this deployment, not to any one organization.',
  'settings.admin.auth-off-title': 'PITCHBOX_AUTH is off',
  'settings.admin.auth-off-description':
    'This instance has no sign-in, so there is only one operator and this area is always reachable - the same reason organization settings disappear from the rail.',
  'settings.admin.intro':
    'A few settings are instance-wide rather than per-organization: any user can create their own organization and become its admin, but that must never grant them the config below, which every organization on this deployment shares. Those pages already existed before this area did and keep their own write gate; this is a landing spot that points at them rather than a second copy of them.',
  'settings.admin.error-promote-failed': 'Could not promote that user',
  'settings.admin.promoted': 'Promoted to instance admin',
  'settings.admin.registration.title': 'Registration policy',
  'settings.admin.registration.description':
    'Whether POST /api/auth/register accepts a new account, and whether it needs a valid invite token. Read fresh on every request, so a change here takes effect without a redeploy. Code default is invite-only.',
  'settings.admin.registration.option-open': 'Open - anyone can register',
  'settings.admin.registration.option-invite': 'Invite-only - a valid invite token is required',
  'settings.admin.registration.option-off': 'Off - no registration at all',
  'settings.admin.registration.error-save-failed': 'Could not save the registration policy',
  'settings.admin.registration.success-saved': 'Registration policy saved',
  'settings.admin.instance-admins.title': 'Instance admins',
  'settings.admin.instance-admins.description':
    "Every user on this deployment and whether they hold the instance-admin flag. Promoting a user here is the supported way to grant it once the deployment's first account has already claimed it (#413) - the only other way is `seed:owner` before anyone signs up.",
  'settings.admin.instance-admins.column-user': 'User',
  'settings.admin.instance-admins.column-instance-admin': 'Instance admin',
  'settings.admin.instance-admins.column-action': 'Action',
  'settings.admin.instance-admins.badge-admin': 'Instance admin',
  'settings.admin.instance-admins.badge-member': 'Member',
  'settings.admin.instance-admins.promote': 'Promote',
  'settings.admin.links.runners-label': 'Agent runners',
  'settings.admin.links.runners-description':
    "Default runner and per-runner config for every organization - not where a function's model is set (see Model configuration).",
  'settings.admin.links.models-label': 'Model configuration',
  'settings.admin.links.models-description':
    'Which Gateway model runs each of the five AI functions - drafting, the in-page assist, project extraction and insights, and campaign-profile generation.',
  'settings.admin.links.quota-label': 'Quota',
  'settings.admin.links.quota-description':
    'Per-platform posting quota defaults shared by every organization.',
  'settings.admin.links.spend-ceiling-label': 'Spend ceiling',
  'settings.admin.links.spend-ceiling-description':
    'Instance-wide Gateway ceiling and the caps a self-registered organization starts with.',
  'settings.admin.links.plan-grants-label': 'Plan grants',
  'settings.admin.links.plan-grants-description':
    'Set or revoke a plan on any organization directly, bypassing Stripe - the self-host fallback and any hand-granted org.',
  'settings.admin.links.retention-label': 'Retention',
  'settings.admin.links.retention-description':
    'How long drafts, run events and webhook deliveries are kept.',
  'settings.admin.links.webhook-label': 'Outgoing webhook',
  'settings.admin.links.webhook-description':
    'The dashboard-wide notification webhook URL and its delivery log.',
  'settings.admin.links.audit-label': 'Audit log',
  'settings.admin.links.audit-description':
    'Who changed instance-wide configuration, when, and from what to what.',

  'settings.admin.audit.seo-title': 'Settings - Instance admin - Audit',
  'settings.admin.audit.seo-description':
    'Who changed instance-wide configuration, when, and from what to what.',
  'settings.admin.audit.title': 'Instance audit log',
  'settings.admin.audit.description':
    "Every instance-wide configuration write - not the per-organization audit feed at /audit, which stays scoped to your own organization's drafts and runs.",
  'settings.admin.audit.column-timestamp': 'Timestamp',
  'settings.admin.audit.column-actor': 'Actor',
  'settings.admin.audit.column-key': 'Key',
  'settings.admin.audit.column-before': 'Before',
  'settings.admin.audit.column-after': 'After',
  'settings.admin.audit.empty': 'No instance-wide configuration has been changed yet.',

  'settings.admin.models.seo-title': 'Settings - Model configuration',
  'settings.admin.models.seo-description': 'Which model runs which job on this deployment.',
  'settings.admin.models.title': 'Model configuration',
  'settings.admin.models.description':
    'Which model does which job. A job nobody configured runs on the coded default, so an unset field is a working deployment rather than a broken one.',
  'settings.admin.models.gateway-info.one':
    '{n} model from the AI Gateway. A change applies to the next run, with no restart.',
  'settings.admin.models.gateway-info.other':
    '{n} models from the AI Gateway. A change applies to the next run, with no restart.',
  'settings.admin.models.select-placeholder': 'Pick a model from the Gateway',
  'settings.admin.models.default-note': 'Default is {modelId}. Clear the field to go back to it.',
  'settings.admin.models.running-default-note': 'Running on the default, {modelId}.',
  'settings.admin.models.save': 'Save',
  'settings.admin.models.saving': 'Saving',
  'settings.admin.models.aria-model-id': 'Model id for {label}',
  'settings.admin.models.toast-error-save': 'Could not save the model',
  'settings.admin.models.toast-success-custom': '{label} now runs on {modelId}',
  'settings.admin.models.toast-success-default': '{label} is back on the default, {modelId}',

  'settings.admin.plan-grants.seo-title': 'Settings - Plan grants',
  'settings.admin.plan-grants.seo-description':
    'Grant or revoke a plan on any organization, bypassing Stripe.',
  'settings.admin.plan-grants.title': 'Plan grants',
  'settings.admin.plan-grants.description':
    'Set or revoke a plan on any organization directly - the self-host fallback and every hand-granted org (mine included) got here without ever touching Stripe.',
  'settings.admin.plan-grants.info':
    'A grant outranks a live Stripe subscription for that org: checkout, the portal and webhook updates all leave a grant alone until it is revoked here. Revoking never guesses - it lands on the plan a mirrored Stripe subscription names, or Free if there is none.',
  'settings.admin.plan-grants.grant-card-title': 'Grant a plan',
  'settings.admin.plan-grants.grant-card-description':
    'Written through the same `setOrgPlan` the Stripe webhook itself calls, recorded in the instance audit log with the reason below.',
  'settings.admin.plan-grants.org-placeholder': 'Pick an organization',
  'settings.admin.plan-grants.plan-placeholder': 'Pick a plan',
  'settings.admin.plan-grants.reason-placeholder':
    'Why this org is on a grant (kept in the audit log, not shown to the org)',
  'settings.admin.plan-grants.grant-button': 'Grant',
  'settings.admin.plan-grants.toast-grant-error': 'Could not grant that plan',
  'settings.admin.plan-grants.toast-grant-success': '{plan} granted',
  'settings.admin.plan-grants.toast-revoke-error': 'Could not revoke that grant',
  'settings.admin.plan-grants.toast-revoke-success': 'Grant revoked',
  'settings.admin.plan-grants.orgs-card-title': 'Organizations',
  'settings.admin.plan-grants.orgs-card-description':
    'Every organization on this deployment, its plan, and where that plan came from.',
  'settings.admin.plan-grants.column-organization': 'Organization',
  'settings.admin.plan-grants.column-plan': 'Plan',
  'settings.admin.plan-grants.column-source': 'Source',
  'settings.admin.plan-grants.column-stripe-customer': 'Stripe customer',
  'settings.admin.plan-grants.column-action': 'Action',
  'settings.admin.plan-grants.source-grant': 'Grant',
  'settings.admin.plan-grants.source-stripe': 'Stripe',
  'settings.admin.plan-grants.source-default': 'Default',
  'settings.admin.plan-grants.stripe-yes': 'Yes',
  'settings.admin.plan-grants.stripe-none': 'None',
  'settings.admin.plan-grants.revoke-button': 'Revoke',
  'settings.admin.plan-grants.confirm-title': 'Revoke the grant on {org}?',
  'settings.admin.plan-grants.confirm-fallback-org': 'this organization',
  'settings.admin.plan-grants.confirm-body':
    'This lands the org on {landing}. Checkout, the portal and the billing page all become reachable again for this org.',
  'settings.admin.plan-grants.confirm-landing-mirrored':
    '{plan}, the plan its mirrored Stripe subscription names',
  'settings.admin.plan-grants.confirm-landing-no-mirror':
    'Free, since it has no mirrored Stripe subscription',
  'settings.admin.plan-grants.cancel': 'Cancel',
  'settings.admin.plan-grants.revoking': 'Revoking…',

  'settings.admin.spend-ceiling.seo-title': 'Settings - Spend ceiling',
  'settings.admin.spend-ceiling.seo-description':
    'The instance-wide Gateway ceiling and what a self-registered organization starts with.',
  'settings.admin.spend-ceiling.title': 'Spend ceiling',
  'settings.admin.spend-ceiling.description':
    'Opening registration to strangers turns a per-organization cap into an unbounded instance-wide one. These two numbers are the backstop: an instance-wide monthly ceiling summed across every organization, and the caps a self-registered organization starts with, separate from what an invited or manually-provisioned organization gets.',
  'settings.admin.spend-ceiling.info':
    "A run refused by the instance ceiling fails with its own reason, distinct from an organization's own budget, so it's clear on which side of the line the money ran out.",
  'settings.admin.spend-ceiling.instance-card-title': 'Instance-wide monthly ceiling',
  'settings.admin.spend-ceiling.instance-card-description':
    'Summed month-to-date Gateway spend across every organization on this deployment. Leave blank for unlimited.',
  'settings.admin.spend-ceiling.instance-budget-label': 'Monthly ceiling (USD)',
  'settings.admin.spend-ceiling.instance-budget-placeholder': 'Unlimited',
  'settings.admin.spend-ceiling.month-to-date-label': 'Month-to-date spend',
  'settings.admin.spend-ceiling.remaining-label': 'Remaining',
  'settings.admin.spend-ceiling.unlimited': 'Unlimited',
  'settings.admin.spend-ceiling.self-reg-card-title': 'Self-registration defaults',
  'settings.admin.spend-ceiling.self-reg-card-description':
    "What a stranger who signs up with no invite starts with (`/register`'s no-invite path). Separate from the invited-organization defaults on purpose: raising what a paying or invited tenant gets never raises what a stranger gets.",
  'settings.admin.spend-ceiling.self-reg-budget-label': 'Monthly run budget (USD)',
  'settings.admin.spend-ceiling.self-reg-concurrency-label': 'Max concurrent runs',
  'settings.admin.spend-ceiling.save': 'Save',
  'settings.admin.spend-ceiling.toast-error-negative': 'Instance ceiling cannot be negative',
  'settings.admin.spend-ceiling.toast-error-budget':
    'Self-registration budget must be a positive number',
  'settings.admin.spend-ceiling.toast-error-concurrency':
    'Self-registration concurrency must be a positive whole number',
  'settings.admin.spend-ceiling.toast-error-forbidden': 'You need instance-admin access for that',
  'settings.admin.spend-ceiling.toast-error-save': 'Could not save',
  'settings.admin.spend-ceiling.toast-success': 'Spend ceiling saved',
} satisfies Dict;
export const settingsIt = {
  'settings.rail.aria-label': 'Sezioni delle impostazioni',
  'settings.rail.section-label': 'Impostazioni',
  'settings.rail.admin-section-label': 'Amministrazione istanza',
  'settings.nav.general': 'Generali',
  'settings.nav.onboarding': 'Onboarding',
  'settings.nav.runners': 'Runner degli agenti',
  'settings.nav.extension': 'Estensione browser',
  'settings.nav.quota': 'Quota',
  'settings.nav.password': 'Password',
  'settings.nav.language': 'Lingua',
  'settings.nav.linkedin-assist': 'Assistente LinkedIn',
  'settings.nav.organization': 'Organizzazione',
  'settings.nav.billing': 'Fatturazione',
  'settings.nav.retention': 'Conservazione',
  'settings.nav.security': 'Sicurezza',
  'settings.nav.admin': 'Amministrazione istanza',

  'settings.general.seo-title': 'Impostazioni - Generali',
  'settings.general.seo-description': 'Stato del daemon e aspetto della dashboard.',
  'settings.general.title': 'Generali',
  'settings.general.description': 'Stato del daemon e aspetto della dashboard.',
  'settings.general.daemon.title': 'Daemon',
  'settings.general.daemon.description':
    'Il daemon si attiva secondo la pianificazione, avvia le campagne con una espressione cron e controlla le risposte ai DM inviati.',
  'settings.general.daemon.admin-required-title':
    "Richiesto l'accesso come amministratore dell'istanza",
  'settings.general.daemon.admin-required-description':
    "Lo stato del daemon riguarda l'intera installazione, non una singola organizzazione, quindi è visibile solo all'amministratore dell'istanza.",
  'settings.general.daemon.unavailable-title': 'Stato non disponibile',
  'settings.general.daemon.unavailable-description':
    'Non è stato possibile leggere il servizio di stato, quindi questo non dice nulla sul daemon stesso. Se la sessione è scaduta, accedi di nuovo e ricarica la pagina.',
  'settings.general.daemon.not-running-title': 'Non in esecuzione',
  'settings.general.daemon.not-running-description': 'Avvialo dalla radice del repository con',
  'settings.general.daemon.age-seconds': '{n}s fa',
  'settings.general.daemon.age-minutes': '{n}m fa',
  'settings.general.daemon.age-hours': '{n}h fa',
  'settings.general.appearance.title': 'Aspetto',
  'settings.general.appearance.theme-label': 'Tema',
  'settings.general.appearance.theme-description':
    'Segui il sistema oppure scegli chiaro o scuro esplicitamente.',
  'settings.general.appearance.theme-system': 'Sistema',
  'settings.general.appearance.theme-light': 'Chiaro',
  'settings.general.appearance.theme-dark': 'Scuro',

  'settings.runners.seo-title': 'Impostazioni - Runner degli agenti',
  'settings.runners.seo-description': 'Rilevamento e configurazione dei runner degli agenti.',
  'settings.runners.title': 'Runner degli agenti',
  'settings.runners.description':
    "Runner degli agenti rilevati, la loro configurazione e quello predefinito dell'organizzazione.",
  'settings.runners.admin-required-title': "Richiesto l'accesso come amministratore",
  'settings.runners.admin-required-description':
    "La configurazione dei runner è visibile agli amministratori e ai proprietari dell'organizzazione. Chiedi a un amministratore se devi verificare la disponibilità di un runner.",
  'settings.runners.card.description':
    "Rilevati verificando ogni CLI del runner all'avvio. Rileva di nuovo dopo un'installazione o un aggiornamento.",
  'settings.runners.card.redetect': 'Rileva di nuovo',
  'settings.runners.card.error-admin-required': "Serve l'accesso da amministratore per farlo",
  'settings.runners.card.error-redetect-failed': 'Nuovo rilevamento non riuscito',
  'settings.runners.card.success-redetected': 'Runner rilevati di nuovo',
  'settings.runners.card.error-set-default-failed': 'Impossibile impostarlo come predefinito',
  'settings.runners.card.success-set-default': '{slug} è ora il runner predefinito',
  'settings.runners.card.empty-title': 'Nessun runner agente installato',
  'settings.runners.card.empty-install-lead': 'Installa una delle CLI supportate, ad esempio',
  'settings.runners.card.empty-install-tail': 'e clicca su',
  'settings.runners.card.default-badge': 'predefinito',
  'settings.runners.card.not-available-yet': 'Non ancora disponibile in questa build.',
  'settings.runners.card.set-default': 'Imposta come predefinito',
  'settings.runners.card.field-cli-default-option': 'Predefinito CLI',
  'settings.runners.card.field-custom-placeholder':
    'Valore personalizzato (sostituisce il selettore sopra)',
  'settings.runners.card.field-default-placeholder': 'predefinito',
  'settings.runners.card.save-config': 'Salva configurazione',
  'settings.runners.card.save-failed': 'Salvataggio non riuscito',
  'settings.runners.card.save-success': 'Configurazione del runner salvata',

  'settings.extension.seo-title': 'Impostazioni - Estensione browser',
  'settings.extension.seo-description': "Abbina e gestisci l'estensione browser di Pitchbox.",
  'settings.extension.title': 'Estensione browser',
  'settings.extension.description':
    "Abbina l'estensione Chrome di Pitchbox a questa dashboard e gestisci i dispositivi abbinati.",
  'settings.extension.card.title': 'Estensione browser',
  'settings.extension.card.description-lead':
    "Abbina l'estensione Chrome di Pitchbox a questa dashboard. L'estensione vive in un pannello laterale persistente: passa automaticamente le bozze a",
  'settings.extension.card.description-tail':
    'quando invii su Reddit, controlla la posta in arrivo e la chat di Reddit per le risposte e mostra ogni operazione in un registro attività in tempo reale. Su LinkedIn, dove il polling non è consentito, il rilevamento di risposte e messaggi è passivo: una risposta raggiunge questa dashboard solo quando apri tu stesso il post, le notifiche o la messaggistica, quindi può restare indietro rispetto a Reddit.',
  'settings.extension.card.pair-heading': 'Abbina questa dashboard',
  'settings.extension.card.pair-step-1':
    "Clicca sull'icona di Pitchbox nella barra degli strumenti di Chrome per aprire il pannello laterale.",
  'settings.extension.card.pair-step-2-lead': 'Apri la scheda',
  'settings.extension.card.pair-step-2-tail': 'poi clicca su',
  'settings.extension.card.pair-step-3':
    'Approva la richiesta una tantum di autorizzazione per questa origine.',
  'settings.extension.card.pair-footer':
    "L'estensione legge il cookie di sessione per generare automaticamente un token per dispositivo. Gestisci e revoca i dispositivi qui sotto.",
  'settings.extension.card.install-summary': "Installa l'estensione",
  'settings.extension.card.install-step-1-lead': 'Dalla radice del repository:',
  'settings.extension.card.install-step-2-lead': 'Apri',
  'settings.extension.card.install-step-2-tail': ', attiva',
  'settings.extension.card.install-step-3-lead': 'Clicca su',
  'settings.extension.card.install-step-3-tail': 'e scegli',
  'settings.extension.card.install-step-4':
    "Clicca sull'icona di Pitchbox per aprire il pannello laterale, poi abbina come sopra.",
  'settings.extension.card.backend-url-lead': 'URL del backend (inseriscilo nel modulo',
  'settings.extension.card.backend-url-tail':
    "dell'estensione, oppure usa un codice di abbinamento):",

  'settings.extension.devices.pairing-title': 'Codice di abbinamento',
  'settings.extension.devices.pairing-description-lead':
    'Genera un codice monouso per abbinare un dispositivo non collegato a questa dashboard. Inseriscilo nel modulo',
  'settings.extension.devices.pairing-description-tail':
    "dell'estensione. I codici scadono dopo 10 minuti.",
  'settings.extension.devices.copy-aria-label': 'Copia il codice di abbinamento',
  'settings.extension.devices.code-expired-title': 'Codice scaduto',
  'settings.extension.devices.code-expired-description': 'Generane uno nuovo qui sotto.',
  'settings.extension.devices.generate-code': 'Genera codice di abbinamento',
  'settings.extension.devices.paired-devices-title': 'Dispositivi abbinati',
  'settings.extension.devices.loading': 'Caricamento dispositivi...',
  'settings.extension.devices.load-error-title': 'Impossibile caricare i dispositivi',
  'settings.extension.devices.retry': 'Riprova',
  'settings.extension.devices.empty-title': 'Ancora nessun dispositivo',
  'settings.extension.devices.empty-description':
    "Abbina l'estensione da una scheda in cui hai effettuato l'accesso, oppure con un codice di abbinamento sopra.",
  'settings.extension.devices.revoked-badge': 'Revocato',
  'settings.extension.devices.seen-ago': 'visto {time}',
  'settings.extension.devices.never-seen': 'mai visto',
  'settings.extension.devices.revoke': 'Revoca',
  'settings.extension.devices.device-revoked': 'Dispositivo revocato',
  'settings.extension.devices.error-admin-required': "Serve l'accesso da amministratore per farlo",
  'settings.extension.devices.error-revoke-failed': 'Impossibile revocare il dispositivo',
  'settings.extension.devices.error-generate-failed':
    'Impossibile generare un codice di abbinamento',
  'settings.extension.devices.pairing-copied': 'Codice di abbinamento copiato',
  'settings.extension.devices.copy-failed':
    'Impossibile copiare, seleziona il codice e copialo manualmente',
  'settings.extension.devices.age-seconds': '{n}s fa',
  'settings.extension.devices.age-minutes': '{n}m fa',
  'settings.extension.devices.age-hours': '{n}h fa',
  'settings.extension.devices.age-days': '{n}g fa',

  'settings.quota.seo-title': 'Impostazioni - Quota',
  'settings.quota.seo-description': 'Limiti predefiniti di pubblicazione per piattaforma.',
  'settings.quota.title': 'Quota',
  'settings.quota.description':
    'Limiti predefiniti di pubblicazione per piattaforma, al giorno e alla settimana.',
  'settings.quota.admin-required-title': "Richiesto l'accesso come amministratore",
  'settings.quota.admin-required-description':
    "Le quote di pubblicazione sono visibili agli amministratori e ai proprietari dell'organizzazione.",
  'settings.quota.unsaved-changes': 'Hai modifiche non salvate',
  'settings.quota.discard': 'Annulla',
  'settings.quota.save': 'Salva',
  'settings.quota.success-saved': 'Limiti salvati',
  'settings.quota.error-admin-required': "Serve l'accesso da amministratore per farlo",
  'settings.quota.error-save-failed': 'Salvataggio non riuscito',
  'settings.quota.card.reset-to-defaults': 'Ripristina i valori predefiniti',
  'settings.quota.card.column-kind': 'Tipo',
  'settings.quota.card.column-per-day': 'Al giorno',
  'settings.quota.card.column-per-week': 'Alla settimana',
  'settings.quota.card.kind-dm': 'DM',
  'settings.quota.card.kind-comment': 'Commenti',
  'settings.quota.card.kind-post': 'Post',
  'settings.quota.card.help-dm':
    'Messaggi diretti. Reddit non pubblica un limite ufficiale; sotto i 15 al giorno è considerato a basso rischio per account con una storia organica.',
  'settings.quota.card.help-comment':
    'Somma di commenti ai post e risposte ai commenti. Reddit applica una limitazione implicita sugli account nuovi.',
  'settings.quota.card.help-post':
    'Post pubblicati. La generazione automatica delle bozze dei post non è ancora collegata: il limite è qui in vista di un uso futuro.',

  'settings.password.seo-title': 'Impostazioni - Password',
  'settings.password.seo-description': 'Cambia la password del tuo account.',
  'settings.password.title': 'Password',
  'settings.password.description': 'Cambia la password per {username}.',
  'settings.password.email-verification-title': 'Verifica email',
  'settings.password.verified-badge': 'Verificata',
  'settings.password.unverified-badge': 'Non verificata',
  'settings.password.unverified-note':
    '- un account non verificato può accedere ma non può ancora avviare un run.',
  'settings.password.sending': 'Invio in corso…',
  'settings.password.resend-verification': 'Reinvia email di verifica',
  'settings.password.change-title': 'Cambia password',
  'settings.password.change-description':
    'Richiede la password attuale. La nuova deve avere almeno 8 caratteri, come per accedere. Cambiarla disconnette ogni altra sessione del tuo account: questa resta connessa.',
  'settings.password.current-password': 'Password attuale',
  'settings.password.new-password': 'Nuova password',
  'settings.password.confirm-password': 'Conferma la nuova password',
  'settings.password.success-changed': 'Password cambiata',
  'settings.password.success-changed-description':
    'Ogni altra sessione del tuo account è stata disconnessa.',
  'settings.password.error-incorrect': 'La password attuale non è corretta',
  'settings.password.error-too-many-attempts': 'Troppi tentativi',
  'settings.password.error-retry-after': 'Riprova tra {n}s',
  'settings.password.error-change-failed': 'Impossibile cambiare la password',
  'settings.password.verify-already-verified': 'Già verificata',
  'settings.password.verify-sent': 'Email di verifica inviata',
  'settings.password.verify-sent-description': 'Controlla {email}.',
  'settings.password.error-resend-failed': "Impossibile reinviare l'email di verifica",

  'settings.security.seo-title': 'Impostazioni - Sicurezza',
  'settings.security.seo-description': 'Accessi falliti recenti e controlli di blocco account.',
  'settings.security.title': 'Sicurezza',
  'settings.security.description': 'Accessi falliti recenti e controlli di blocco account.',
  'settings.security.policy.title': 'Politica',
  'settings.security.policy.description-lead': 'Il blocco scatta dopo',
  'settings.security.policy.description-within': 'entro',
  'settings.security.policy.description-then':
    '; da quel momento i tentativi restituiscono HTTP 429 per',
  'settings.security.policy.tune-lead': 'Regola tramite la riga',
  'settings.security.policy.tune-mid': 'in',
  'settings.security.policy.attempts.one': '{n} tentativo fallito',
  'settings.security.policy.attempts.other': '{n} tentativi falliti',
  'settings.security.policy.minutes.one': '{n} minuto',
  'settings.security.policy.minutes.other': '{n} minuti',
  'settings.security.unlock.title': 'Sblocca account',
  'settings.security.unlock.description':
    'Azzera il contatore mobile dei fallimenti per il nome utente indicato.',
  'settings.security.unlock.username-placeholder': 'nome utente',
  'settings.security.unlock.error-empty': 'Inserisci prima un nome utente',
  'settings.security.unlock.success.one': '{n} fallimento azzerato per {name}',
  'settings.security.unlock.success.other': '{n} fallimenti azzerati per {name}',
  'settings.security.unlock.error-admin-required': "Serve l'accesso da amministratore per farlo",
  'settings.security.unlock.error-failed': 'Sblocco non riuscito',
  'settings.security.recent-failures.title': 'Fallimenti recenti',
  'settings.security.recent-failures.description':
    'Ultimi 50 tentativi di accesso falliti (i più recenti per primi).',
  'settings.security.recent-failures.empty-title': 'Tutto tranquillo',
  'settings.security.recent-failures.empty-description':
    'Nessun tentativo di accesso fallito registrato.',
  'settings.security.recent-failures.column-identifier': 'Identificativo',
  'settings.security.recent-failures.column-kind': 'Tipo',
  'settings.security.recent-failures.column-when': 'Quando',
  'settings.security.age-seconds': '{n}s fa',
  'settings.security.age-minutes': '{n}m fa',
  'settings.security.age-hours': '{n}h fa',
  'settings.security.age-days': '{n}g fa',

  'settings.retention.seo-title': 'Impostazioni - Conservazione',
  'settings.retention.seo-description':
    'Configura per quanto tempo le bozze e i registri eventi vengono conservati prima della pulizia.',
  'settings.retention.title': 'Conservazione',
  'settings.retention.description':
    'Per quanto tempo le bozze concluse e i registri eventi vengono conservati prima che il daemon li elimini.',
  'settings.retention.policy-title': 'Politica',
  'settings.retention.policy-description':
    'I valori sotto {floor} giorni vengono portati a {floor} lato server. Lo storico dei contatti non viene mai eliminato da questa politica.',
  'settings.retention.field-drafts': 'Bozze (inviate / rifiutate / risposte ricevute)',
  'settings.retention.field-run-events': 'Eventi dei run',
  'settings.retention.field-draft-events': 'Eventi delle bozze',
  'settings.retention.field-webhook-deliveries': 'Consegne webhook',
  'settings.retention.save': 'Salva',
  'settings.retention.success-saved': 'Politica di conservazione salvata',
  'settings.retention.error-invalid-number': 'Numero non valido',

  'settings.linkedin-assist.seo-title': 'Impostazioni - Assistente LinkedIn',
  'settings.linkedin-assist.seo-description':
    "Attivazione, limiti giornalieri e interruttore di emergenza per l'assistente in pagina di LinkedIn.",
  'settings.linkedin-assist.title': 'Assistente LinkedIn',
  'settings.linkedin-assist.description':
    "Controlla l'assistente in pagina su linkedin.com: quanto può inviare, e un interruttore di emergenza che si applica subito.",
  'settings.linkedin-assist.kill-switch-banner-title': "L'interruttore di emergenza è attivo",
  'settings.linkedin-assist.kill-switch-banner-description':
    'Suggerimenti e raccolta osservazioni sono fermi su ogni dispositivo di questa organizzazione, a prescindere dalle impostazioni sottostanti.',
  'settings.linkedin-assist.assist.title': 'Assistente',
  'settings.linkedin-assist.assist.description':
    "Disattivato di default. Scrive come te, l'operatore: decide a quale dei tuoi progetti (se presente) un suggerimento si riferisce a partire dal post stesso, quindi non c'è nulla da associare qui.",
  'settings.linkedin-assist.assist.enabled-label': 'Assistente attivo',
  'settings.linkedin-assist.assist.collector-enabled-label': 'Raccolta osservazioni attiva',
  'settings.linkedin-assist.assist.project-label': 'Il raccoglitore attribuisce gli avvistamenti a',
  'settings.linkedin-assist.assist.project-placeholder': 'Nessun progetto associato',
  'settings.linkedin-assist.assist.project-description':
    'Usato solo dal raccoglitore di osservazioni, per archiviare ciò che scorre sotto uno dei tuoi progetti, da cui le campagne di quel progetto attingono candidati. Non è collegato a ciò su cui scrive un suggerimento.',
  'settings.linkedin-assist.tone.title': 'Tono',
  'settings.linkedin-assist.tone.description':
    "Come dovrebbe suonare un suggerimento, di default. Lo stile della casa prevale su ogni opzione qui, quindi nessuna può chiedere una tipografia che Pitchbox non usa mai, e un tono inviato dall'estensione viene ignorato: è questa pagina e la pagina del progetto a deciderlo. Ogni progetto può sovrascriverlo per sé stesso, aprendo il progetto e cercando Voce, così un prodotto non deve suonare come il tuo account personale.",
  'settings.linkedin-assist.tone.register-label': 'Registro',
  'settings.linkedin-assist.tone.custom-label': 'Con parole tue',
  'settings.linkedin-assist.tone.custom-placeholder':
    "Diretto, un po' asciutto, senza entusiasmo che non direi ad alta voce",
  'settings.linkedin-assist.tone.custom-description':
    'Entra nel prompt così come lo scrivi, fino a {max} caratteri.',
  'settings.linkedin-assist.tone.option-match-room-label': "Segui l'ambiente",
  'settings.linkedin-assist.tone.option-match-room-hint':
    'Mescola il registro del post con la tua voce. È il default, ed è quello che farebbe davvero una persona.',
  'settings.linkedin-assist.tone.option-professional-label': 'Professionale',
  'settings.linkedin-assist.tone.option-professional-hint':
    'Frasi complete, niente slang e niente riempitivi da azienda.',
  'settings.linkedin-assist.tone.option-plain-label': 'Semplice',
  'settings.linkedin-assist.tone.option-plain-hint': 'Frasi brevi e parole comuni.',
  'settings.linkedin-assist.tone.option-warm-label': 'Caloroso',
  'settings.linkedin-assist.tone.option-warm-hint':
    "Si rivolge all'autore come una persona, senza punti esclamativi.",
  'settings.linkedin-assist.tone.option-technical-label': 'Tecnico',
  'settings.linkedin-assist.tone.option-technical-hint':
    'Specifico su meccanismi, numeri e compromessi.',
  'settings.linkedin-assist.tone.option-custom-label': 'Con parole mie',
  'settings.linkedin-assist.tone.option-custom-hint': 'Descrivi tu stesso il tono, qui sotto.',
  'settings.linkedin-assist.caps.title': 'Limiti giornalieri',
  'settings.linkedin-assist.caps.description':
    'Può solo essere abbassato, mai portato oltre il limite del codice: il monitoraggio della velocità di LinkedIn tratta un account ad alto volume come un bot, indipendentemente da quanto sia stato scritto con cura.',
  'settings.linkedin-assist.caps.comments-label': 'Commenti / giorno',
  'settings.linkedin-assist.caps.posts-label': 'Post / giorno',
  'settings.linkedin-assist.caps.ceiling': 'Limite massimo: {n} / giorno',
  'settings.linkedin-assist.kill-switch.title': 'Interruttore di emergenza',
  'settings.linkedin-assist.kill-switch.description':
    'Ferma raccolta e suggerimenti immediatamente, su ogni dispositivo, senza aspettare il prossimo allarme. È diverso dal disattivare l\'assistente: usalo per "qualcosa non va adesso", non per una pausa di routine.',
  'settings.linkedin-assist.kill-switch.engaged-label': 'Interruttore di emergenza attivo',
  'settings.linkedin-assist.selector-health.title': 'Stato dei selettori',
  'settings.linkedin-assist.selector-health.description':
    "Se l'estensione riesce ancora a trovare il feed, il compositore e i controlli di invio di LinkedIn (LI-6, #303). Il modo di guasto che questo previene è la rottura silenziosa: un assistente che smette di trovare i post senza avvisare sembra identico a una settimana tranquilla.",
  'settings.linkedin-assist.selector-health.empty-title': 'Ancora nessuna segnalazione',
  'settings.linkedin-assist.selector-health.empty-description':
    'Nessuna estensione installata ha ancora segnalato nulla. Questa scheda si popolerà quando il raccoglitore (#302) sarà pubblicato e inizierà a segnalare qui lo stato dei selettori.',
  'settings.linkedin-assist.unsaved-changes': 'Hai modifiche non salvate',
  'settings.linkedin-assist.discard': 'Annulla',
  'settings.linkedin-assist.save': 'Salva',
  'settings.linkedin-assist.error-tone-required':
    'Descrivi il tono che vuoi, oppure scegli una delle opzioni predefinite',
  'settings.linkedin-assist.success-saved': "Impostazioni dell'assistente LinkedIn salvate",
  'settings.linkedin-assist.error-admin-required': "Serve l'accesso da amministratore per farlo",
  'settings.linkedin-assist.error-save-failed': 'Salvataggio non riuscito',

  'settings.organization.seo-title': 'Impostazioni - Organizzazione',
  'settings.organization.seo-description':
    'Nome dell\u2019organizzazione, ruoli, membri, inviti e zona pericolosa.',
  'settings.organization.title': 'Organizzazione',
  'settings.organization.description-no-org': 'Le impostazioni della tua organizzazione.',
  'settings.organization.sign-in-prompt':
    'Accedi per vedere e gestire le persone nella tua organizzazione.',
  'settings.organization.auth-off-lead':
    'Questa istanza gira con PITCHBOX_AUTH disattivato, quindi non ci sono organizzazioni o ruoli di appartenenza da gestire. Imposta PITCHBOX_AUTH=on nel tuo ambiente per attivarli; consulta la',
  'settings.organization.auth-off-link': 'documentazione sull\u2019autenticazione',
  'settings.organization.auth-off-tail': 'per sapere come attivarla.',
  'settings.organization.card-title': 'Organizzazione',
  'settings.organization.name-label': 'Nome',
  'settings.organization.save': 'Salva',
  'settings.organization.cancel': 'Annulla',
  'settings.organization.rename': 'Rinomina',
  'settings.organization.url-slug-label': 'Slug URL',
  'settings.organization.quota-title': 'Quota e budget',
  'settings.organization.quota-description':
    'Limita la spesa e la concorrenza sul runner cloud di questa organizzazione. Lascia un campo vuoto per illimitato.',
  'settings.organization.monthly-budget-label': 'Budget mensile per i run (USD)',
  'settings.organization.max-concurrent-label': 'Run simultanei massimi',
  'settings.organization.unlimited': 'Illimitato',
  'settings.organization.month-to-date-label': 'Spesa dall\u2019inizio del mese',
  'settings.organization.remaining-budget-label': 'Budget rimanente',
  'settings.organization.campaign-spend-label': 'Spesa delle campagne',
  'settings.organization.assistant-spend-label': "Spesa dell'assistente",
  'settings.organization.assistant-spend-note': '- suggerimenti LinkedIn, non run di campagna',
  'settings.organization.roles-title': 'Ruoli',
  'settings.organization.roles-description': 'Cosa può fare ogni ruolo in questa organizzazione.',
  'settings.organization.cannot-prefix': 'Non può:',
  'settings.organization.role-caps.member-can':
    'Lavorare su campagne e bozze, avviare agenti, gestire keyword watch e template.',
  'settings.organization.role-caps.member-cant':
    "Gestire progetti, account, impostazioni dell'organizzazione o membri.",
  'settings.organization.role-caps.admin-can':
    'Tutto quello che può fare un membro, più progetti, account, eliminazioni, impostazioni e membri.',
  'settings.organization.role-caps.admin-cant':
    "Gestire i proprietari o eliminare l'organizzazione.",
  'settings.organization.role-caps.owner-can':
    "Controllo completo: tutto quello che può fare un amministratore, più la gestione dei proprietari e l'eliminazione dell'organizzazione.",
  'settings.organization.role-hint.member': "Può vedere e lavorare nell'organizzazione.",
  'settings.organization.role-hint.admin': 'Può anche invitare persone e gestire i membri.',
  'settings.organization.role-hint.owner':
    "Controllo completo, inclusa la gestione dei proprietari e l'eliminazione dell'organizzazione.",
  'settings.organization.members-title': 'Membri',
  'settings.organization.people-count.one': 'persona',
  'settings.organization.people-count.other': 'persone',
  'settings.organization.people-in-org': 'in {org}',
  'settings.organization.invite-member': 'Invita un membro',
  'settings.organization.you-suffix': '(tu)',
  'settings.organization.joined-on': 'entrato il {date}',
  'settings.organization.manage-member': 'Gestisci {name}',
  'settings.organization.change-role': 'Cambia ruolo',
  'settings.organization.make-role': 'Rendi {role}',
  'settings.organization.remove-from-org': "Rimuovi dall'organizzazione",
  'settings.organization.pending-invites-title': 'Inviti in sospeso',
  'settings.organization.pending-invites-description': 'Link non ancora accettati.',
  'settings.organization.no-pending-invites': 'Nessun invito in sospeso.',
  'settings.organization.expires-label': 'scade {time}',
  'settings.organization.expires-soon': 'a breve',
  'settings.organization.expires-in-days.one': 'tra {n} giorno',
  'settings.organization.expires-in-days.other': 'tra {n} giorni',
  'settings.organization.copy-link': 'Copia link',
  'settings.organization.revoke': 'Revoca',
  'settings.organization.danger-zone-title': 'Zona pericolosa',
  'settings.organization.leave-org-title': "Lascia l'organizzazione",
  'settings.organization.leave-org-description': 'Rimuoviti da {org}.',
  'settings.organization.leave': 'Lascia',
  'settings.organization.delete-org-title': "Elimina l'organizzazione",
  'settings.organization.delete-org-description':
    'Elimina definitivamente {org} e tutti i suoi progetti, campagne e bozze.',
  'settings.organization.delete': 'Elimina',
  'settings.organization.invite-dialog-title': 'Invita un membro',
  'settings.organization.invite-dialog-description':
    'Scegli un ruolo e, se lo hai, un indirizzo email. Scade tra 7 giorni.',
  'settings.organization.role-label': 'Ruolo',
  'settings.organization.email-optional-label': 'Email (opzionale)',
  'settings.organization.email-not-configured-note':
    'Se la posta non è configurata su questa installazione, riceverai comunque un link da condividere a mano.',
  'settings.organization.invite-link-label': 'Link di invito',
  'settings.organization.copy-link-aria': 'Copia link',
  'settings.organization.invite-sent-note':
    'Inviato a {email}. Se non arriva, condividi questo link al suo posto.',
  'settings.organization.invite-mail-not-configured':
    'La posta non è configurata su questa installazione, quindi condividi questo link direttamente con {email}.',
  'settings.organization.invite-anyone-note-lead': 'Chiunque abbia questo link può unirsi come',
  'settings.organization.generate-another': 'Generane un altro',
  'settings.organization.done': 'Fatto',
  'settings.organization.send-invite': 'Invia invito',
  'settings.organization.generate-link': 'Genera link',
  'settings.organization.delete-dialog-description':
    'Questo elimina definitivamente {org} e tutti i suoi progetti, campagne e bozze. Non può essere annullato.',
  'settings.organization.type-to-confirm-lead': 'Digita',
  'settings.organization.type-to-confirm-tail': 'per confermare',
  'settings.organization.invite-link-copied': 'Link di invito copiato',
  'settings.organization.copy-failed':
    'Impossibile copiare, seleziona il link e copialo manualmente',
  'settings.organization.error-invite-forbidden':
    'Solo proprietari e amministratori possono invitare persone',
  'settings.organization.error-invalid-email': 'Inserisci un indirizzo email valido',
  'settings.organization.error-invite-failed': "Impossibile creare l'invito",
  'settings.organization.invite-sent-to': 'Invito inviato a {email}',
  'settings.organization.error-revoke-invite-failed': "Impossibile revocare l'invito",
  'settings.organization.invite-revoked': 'Invito revocato',
  'settings.organization.error-not-allowed': 'Non consentito',
  'settings.organization.error-change-role-failed': 'Impossibile cambiare il ruolo',
  'settings.organization.role-updated': 'Ruolo aggiornato',
  'settings.organization.error-remove-member-failed': 'Impossibile rimuovere il membro',
  'settings.organization.member-removed': '{username} rimosso',
  'settings.organization.error-name-required': "Inserisci un nome per l'organizzazione",
  'settings.organization.error-admin-required-rename':
    "Serve l'accesso da amministratore per rinominare",
  'settings.organization.error-rename-failed': 'Impossibile rinominare',
  'settings.organization.org-renamed': 'Organizzazione rinominata',
  'settings.organization.error-budget-negative': 'Il budget mensile non può essere negativo',
  'settings.organization.error-cap-negative':
    'I run simultanei massimi non possono essere negativi',
  'settings.organization.error-admin-required': "Serve l'accesso da amministratore per farlo",
  'settings.organization.error-quota-save-failed': 'Impossibile salvare la quota',
  'settings.organization.quota-saved': 'Quota salvata',
  'settings.organization.error-cannot-leave': 'Impossibile lasciare',
  'settings.organization.error-leave-failed': "Impossibile lasciare l'organizzazione",
  'settings.organization.left-org': 'Hai lasciato l\u2019organizzazione',
  'settings.organization.error-only-owner-deletes':
    "Solo un proprietario può eliminare l'organizzazione",
  'settings.organization.error-delete-failed': "Impossibile eliminare l'organizzazione",
  'settings.organization.org-deleted': 'Organizzazione eliminata',
  'settings.organization.close-dialog-aria': 'Chiudi finestra',
  'settings.organization.remove-member-title': 'Rimuovi membro',
  'settings.organization.remove-member-description-lead': 'Questo rimuove',
  'settings.organization.remove-member-description-mid':
    'da {org}. Perderà immediatamente accesso a ogni progetto dell\u2019organizzazione. Digita il suo nome utente',
  'settings.organization.remove-member-description-tail': 'per confermare.',
  'settings.organization.username-label': 'Nome utente',
  'settings.organization.leave-dialog-description-lead': 'Questo rimuove il tuo accesso a',
  'settings.organization.leave-dialog-description-mid':
    "e a tutto ciò che contiene: progetti, campagne e bozze. Ti servirà un nuovo invito per rientrare. Digita il nome dell'organizzazione",
  'settings.organization.leave-dialog-description-tail': 'per confermare.',
  'settings.organization.org-name-label': "Nome dell'organizzazione",

  'settings.language.seo-title': 'Impostazioni - Lingua',
  'settings.language.seo-description': 'Scegli la lingua di visualizzazione della dashboard.',
  'settings.language.title': 'Lingua',
  'settings.language.description':
    "Si applica alla dashboard e, al prossimo aggancio, all'estensione browser: è un'unica impostazione dell'account, non una per ogni superficie.",
  'settings.language.display-language-title': 'Lingua di visualizzazione',
  'settings.language.display-language-description':
    'Le pagine da disconnesso continuano a usare la lingua del tuo browser finché non accedi.',
  'settings.language.success-saved': 'Lingua salvata',
  'settings.language.error-save-failed': 'Impossibile salvare la lingua',

  'settings.billing.seo-title': 'Impostazioni - Fatturazione',
  'settings.billing.seo-description':
    'Il tuo piano, cosa ne è stato usato in questo periodo e come cambiarlo.',
  'settings.billing.title': 'Fatturazione',
  'settings.billing.description':
    'Il piano, cosa ne è stato usato in questo periodo e i due modi reali per cambiarlo.',
  'settings.billing.self-hosted-title': 'Self-hosted',
  'settings.billing.self-hosted-description':
    "Questa installazione gira fuori dall'edizione cloud, quindi ogni limite è illimitato e non c'è nulla da fatturare. Qui non c'è un piano da scegliere né un portale da aprire.",
  'settings.billing.read-only-since': 'Account in sola lettura dal {date}',
  'settings.billing.read-only-description':
    'Un pagamento non è riuscito e nulla è andato a buon fine durante il periodo di grazia. Nuovi run, suggerimenti, accettazioni, progetti, campagne, inviti e dispositivi sono rifiutati finché il metodo di pagamento non viene corretto nel portale qui sotto.',
  'settings.billing.grace-period-until': 'Pagamento non riuscito: periodo di grazia fino al {date}',
  'settings.billing.grace-period-description':
    'Il piano continua a funzionare normalmente fino ad allora. Aggiorna il metodo di pagamento nel portale qui sotto prima del {date} per evitare la sola lettura.',
  'settings.billing.granted-badge': 'Concesso',
  'settings.billing.granted-description':
    "Questo piano è stato concesso da un amministratore dell'istanza. Non è fatturato tramite Stripe e non cambia da questa pagina.",
  'settings.billing.free-description':
    'Nessun abbonamento. Free copre un singolo progetto, offerto dalla casa.',
  'settings.billing.cancels-on': 'si annulla il {date}',
  'settings.billing.renews-on': 'si rinnova il {date}',
  'settings.billing.switches-to': 'passa a {plan} il {date}',
  'settings.billing.per-month': '/ mese',
  'settings.billing.or': 'oppure',
  'settings.billing.per-year': '/ anno',
  'settings.billing.monthly': 'Mensile',
  'settings.billing.yearly': 'Annuale',
  'settings.billing.open-customer-portal': 'Apri il portale clienti',
  'settings.billing.portal-note':
    'Cambia piano, aggiorna il metodo di pagamento o consulta le fatture nel portale. Nulla qui scrive un piano direttamente: il portale e il suo webhook sono l\u2019unico percorso.',
  'settings.billing.usage-title': 'Utilizzo di questo periodo',
  'settings.billing.usage-description':
    'Cosa misura il piano, confrontato con i suoi limiti. Una metrica che il piano lascia senza limite mostra illimitato invece di una barra piena.',
  'settings.billing.metric-runs': 'Run',
  'settings.billing.metric-suggestions': 'Suggerimenti',
  'settings.billing.metric-projects': 'Progetti',
  'settings.billing.metric-accounts': 'Account collegati',
  'settings.billing.metric-seats': 'Posti',
  'settings.billing.metric-devices': 'Dispositivi abbinati',
  'settings.billing.model-allowance-label': 'Modello utilizzato',
  'settings.billing.model-allowance-description':
    "Quanto dell'allocazione di spesa modello di questo periodo l'organizzazione ha usato. Non è una voce di fattura: quelle sono nel portale.",
  'settings.billing.unlimited': 'Illimitato',
  'settings.billing.error-checkout-failed': 'Impossibile avviare il checkout',
  'settings.billing.error-portal-failed': 'Impossibile aprire il portale clienti',

  'settings.admin.seo-title': 'Impostazioni - Amministrazione istanza',
  'settings.admin.seo-description':
    "Configurazione a livello di istanza per l'operatore di questa installazione.",
  'settings.admin.title': 'Amministrazione istanza',
  'settings.admin.description':
    "Configurazione che appartiene all'operatore di questa installazione, non a una singola organizzazione.",
  'settings.admin.auth-off-title': 'PITCHBOX_AUTH è disattivato',
  'settings.admin.auth-off-description':
    "Questa istanza non ha accesso, quindi c'è un solo operatore e quest'area è sempre raggiungibile: lo stesso motivo per cui le impostazioni dell'organizzazione scompaiono dal menu.",
  'settings.admin.intro':
    "Alcune impostazioni riguardano l'intera istanza anziché una singola organizzazione: chiunque può creare la propria organizzazione e diventarne amministratore, ma questo non deve mai concedergli la configurazione qui sotto, condivisa da ogni organizzazione di questa installazione. Quelle pagine esistevano già prima di quest'area e mantengono il proprio controllo di scrittura; questo è un punto di atterraggio che punta a loro, non una loro copia.",
  'settings.admin.error-promote-failed': "Impossibile promuovere quell'utente",
  'settings.admin.promoted': 'Promosso ad amministratore istanza',
  'settings.admin.registration.title': 'Politica di registrazione',
  'settings.admin.registration.description':
    'Se POST /api/auth/register accetta un nuovo account e se richiede un token di invito valido. Letta di nuovo a ogni richiesta, quindi una modifica qui ha effetto senza un nuovo deploy. Il valore predefinito nel codice è solo su invito.',
  'settings.admin.registration.option-open': 'Aperta - chiunque può registrarsi',
  'settings.admin.registration.option-invite': 'Solo su invito - serve un token di invito valido',
  'settings.admin.registration.option-off': 'Disattivata - nessuna registrazione',
  'settings.admin.registration.error-save-failed':
    'Impossibile salvare la politica di registrazione',
  'settings.admin.registration.success-saved': 'Politica di registrazione salvata',
  'settings.admin.instance-admins.title': 'Amministratori istanza',
  'settings.admin.instance-admins.description':
    "Ogni utente di questa installazione e se possiede il flag di amministratore istanza. Promuovere un utente qui è il modo previsto per concederlo una volta che il primo account dell'installazione lo ha già ottenuto (#413): l'unico altro modo è `seed:owner` prima che chiunque si registri.",
  'settings.admin.instance-admins.column-user': 'Utente',
  'settings.admin.instance-admins.column-instance-admin': 'Amministratore istanza',
  'settings.admin.instance-admins.column-action': 'Azione',
  'settings.admin.instance-admins.badge-admin': 'Amministratore istanza',
  'settings.admin.instance-admins.badge-member': 'Membro',
  'settings.admin.instance-admins.promote': 'Promuovi',
  'settings.admin.links.runners-label': 'Runner degli agenti',
  'settings.admin.links.runners-description':
    'Runner predefinito e configurazione per runner di ogni organizzazione: non è qui che si imposta il modello di una funzione (vedi Configurazione modello).',
  'settings.admin.links.models-label': 'Configurazione modello',
  'settings.admin.links.models-description':
    'Quale modello Gateway esegue ciascuna delle cinque funzioni AI: stesura, assistenza in pagina, estrazione e insight dei progetti, generazione del profilo campagna.',
  'settings.admin.links.quota-label': 'Quota',
  'settings.admin.links.quota-description':
    'Quote predefinite di pubblicazione per piattaforma, condivise da ogni organizzazione.',
  'settings.admin.links.spend-ceiling-label': 'Tetto di spesa',
  'settings.admin.links.spend-ceiling-description':
    "Tetto Gateway a livello di istanza e i limiti con cui parte un'organizzazione auto-registrata.",
  'settings.admin.links.plan-grants-label': 'Concessioni piano',
  'settings.admin.links.plan-grants-description':
    'Imposta o revoca un piano su qualsiasi organizzazione direttamente, aggirando Stripe: il fallback self-host e qualunque organizzazione concessa a mano.',
  'settings.admin.links.retention-label': 'Conservazione',
  'settings.admin.links.retention-description':
    'Per quanto tempo vengono conservati bozze, eventi dei run e consegne webhook.',
  'settings.admin.links.webhook-label': 'Webhook in uscita',
  'settings.admin.links.webhook-description':
    "L'URL del webhook di notifica dell'intera dashboard e il suo registro di consegna.",
  'settings.admin.links.audit-label': 'Registro di controllo',
  'settings.admin.links.audit-description':
    'Chi ha cambiato la configurazione a livello di istanza, quando e da cosa a cosa.',

  'settings.admin.audit.seo-title':
    'Impostazioni - Amministrazione istanza - Registro di controllo',
  'settings.admin.audit.seo-description':
    'Chi ha cambiato la configurazione a livello di istanza, quando e da cosa a cosa.',
  'settings.admin.audit.title': "Registro di controllo dell'istanza",
  'settings.admin.audit.description':
    'Ogni scrittura di configurazione a livello di istanza: non il registro di controllo per organizzazione in /audit, che resta limitato alle bozze e ai run della tua organizzazione.',
  'settings.admin.audit.column-timestamp': 'Data e ora',
  'settings.admin.audit.column-actor': 'Autore',
  'settings.admin.audit.column-key': 'Chiave',
  'settings.admin.audit.column-before': 'Prima',
  'settings.admin.audit.column-after': 'Dopo',
  'settings.admin.audit.empty':
    'Nessuna configurazione a livello di istanza è stata ancora modificata.',

  'settings.admin.models.seo-title': 'Impostazioni - Configurazione modello',
  'settings.admin.models.seo-description':
    'Quale modello esegue quale compito in questa installazione.',
  'settings.admin.models.title': 'Configurazione modello',
  'settings.admin.models.description':
    "Quale modello svolge quale compito. Un compito che nessuno ha configurato viene eseguito sul valore predefinito nel codice, quindi un campo vuoto indica un'installazione funzionante, non guasta.",
  'settings.admin.models.gateway-info.one':
    '{n} modello dal Gateway AI. Una modifica si applica al prossimo run, senza riavvio.',
  'settings.admin.models.gateway-info.other':
    '{n} modelli dal Gateway AI. Una modifica si applica al prossimo run, senza riavvio.',
  'settings.admin.models.select-placeholder': 'Scegli un modello dal Gateway',
  'settings.admin.models.default-note': 'Il predefinito è {modelId}. Svuota il campo per tornarci.',
  'settings.admin.models.running-default-note': 'In esecuzione sul predefinito, {modelId}.',
  'settings.admin.models.save': 'Salva',
  'settings.admin.models.saving': 'Salvataggio',
  'settings.admin.models.aria-model-id': 'ID modello per {label}',
  'settings.admin.models.toast-error-save': 'Impossibile salvare il modello',
  'settings.admin.models.toast-success-custom': 'Ora {label} usa {modelId}',
  'settings.admin.models.toast-success-default': '{label} è tornato al predefinito, {modelId}',

  'settings.admin.plan-grants.seo-title': 'Impostazioni - Concessioni piano',
  'settings.admin.plan-grants.seo-description':
    'Concedi o revoca un piano su qualsiasi organizzazione, aggirando Stripe.',
  'settings.admin.plan-grants.title': 'Concessioni piano',
  'settings.admin.plan-grants.description':
    'Imposta o revoca un piano su qualsiasi organizzazione direttamente: il fallback self-host e ogni organizzazione concessa a mano (compresa la mia) sono arrivate qui senza mai passare da Stripe.',
  'settings.admin.plan-grants.info':
    "Una concessione prevale su un abbonamento Stripe attivo per quell'organizzazione: checkout, portale e aggiornamenti webhook lasciano intatta una concessione finché non viene revocata qui. La revoca non indovina mai: torna al piano indicato da un abbonamento Stripe rispecchiato, o a Free se non ce n'è uno.",
  'settings.admin.plan-grants.grant-card-title': 'Concedi un piano',
  'settings.admin.plan-grants.grant-card-description':
    "Scritta tramite la stessa `setOrgPlan` chiamata dal webhook Stripe, registrata nel registro di controllo dell'istanza con il motivo qui sotto.",
  'settings.admin.plan-grants.org-placeholder': "Scegli un'organizzazione",
  'settings.admin.plan-grants.plan-placeholder': 'Scegli un piano',
  'settings.admin.plan-grants.reason-placeholder':
    "Perché questa organizzazione ha una concessione (resta nel registro di controllo, non è visibile all'organizzazione)",
  'settings.admin.plan-grants.grant-button': 'Concedi',
  'settings.admin.plan-grants.toast-grant-error': 'Impossibile concedere quel piano',
  'settings.admin.plan-grants.toast-grant-success': '{plan} concesso',
  'settings.admin.plan-grants.toast-revoke-error': 'Impossibile revocare quella concessione',
  'settings.admin.plan-grants.toast-revoke-success': 'Concessione revocata',
  'settings.admin.plan-grants.orgs-card-title': 'Organizzazioni',
  'settings.admin.plan-grants.orgs-card-description':
    'Ogni organizzazione di questa installazione, il suo piano e da dove proviene quel piano.',
  'settings.admin.plan-grants.column-organization': 'Organizzazione',
  'settings.admin.plan-grants.column-plan': 'Piano',
  'settings.admin.plan-grants.column-source': 'Origine',
  'settings.admin.plan-grants.column-stripe-customer': 'Cliente Stripe',
  'settings.admin.plan-grants.column-action': 'Azione',
  'settings.admin.plan-grants.source-grant': 'Concessione',
  'settings.admin.plan-grants.source-stripe': 'Stripe',
  'settings.admin.plan-grants.source-default': 'Predefinito',
  'settings.admin.plan-grants.stripe-yes': 'Sì',
  'settings.admin.plan-grants.stripe-none': 'Nessuno',
  'settings.admin.plan-grants.revoke-button': 'Revoca',
  'settings.admin.plan-grants.confirm-title': 'Revocare la concessione su {org}?',
  'settings.admin.plan-grants.confirm-fallback-org': 'questa organizzazione',
  'settings.admin.plan-grants.confirm-body':
    "Questo riporta l'organizzazione a {landing}. Checkout, portale e pagina di fatturazione tornano di nuovo raggiungibili per questa organizzazione.",
  'settings.admin.plan-grants.confirm-landing-mirrored':
    '{plan}, il piano indicato dal suo abbonamento Stripe rispecchiato',
  'settings.admin.plan-grants.confirm-landing-no-mirror':
    'Free, poiché non ha un abbonamento Stripe rispecchiato',
  'settings.admin.plan-grants.cancel': 'Annulla',
  'settings.admin.plan-grants.revoking': 'Revoca in corso…',

  'settings.admin.spend-ceiling.seo-title': 'Impostazioni - Tetto di spesa',
  'settings.admin.spend-ceiling.seo-description':
    "Il tetto Gateway a livello di istanza e i limiti con cui parte un'organizzazione auto-registrata.",
  'settings.admin.spend-ceiling.title': 'Tetto di spesa',
  'settings.admin.spend-ceiling.description':
    "Aprire la registrazione a sconosciuti trasforma un limite per organizzazione in uno illimitato a livello di istanza. Questi due numeri sono la rete di sicurezza: un tetto mensile a livello di istanza sommato su ogni organizzazione, e i limiti con cui parte un'organizzazione auto-registrata, separati da quelli di un'organizzazione invitata o creata manualmente.",
  'settings.admin.spend-ceiling.info':
    "Un run rifiutato dal tetto di istanza fallisce con un motivo proprio, distinto dal budget dell'organizzazione, così è chiaro da quale lato si sono esauriti i fondi.",
  'settings.admin.spend-ceiling.instance-card-title': 'Tetto mensile a livello di istanza',
  'settings.admin.spend-ceiling.instance-card-description':
    "Spesa Gateway dall'inizio del mese sommata su ogni organizzazione di questa installazione. Lascia vuoto per illimitato.",
  'settings.admin.spend-ceiling.instance-budget-label': 'Tetto mensile (USD)',
  'settings.admin.spend-ceiling.instance-budget-placeholder': 'Illimitato',
  'settings.admin.spend-ceiling.month-to-date-label': 'Spesa da inizio mese',
  'settings.admin.spend-ceiling.remaining-label': 'Rimanente',
  'settings.admin.spend-ceiling.unlimited': 'Illimitato',
  'settings.admin.spend-ceiling.self-reg-card-title': "Valori predefiniti per l'auto-registrazione",
  'settings.admin.spend-ceiling.self-reg-card-description':
    'Con cosa parte uno sconosciuto che si registra senza invito (il percorso senza invito di `/register`). Separato di proposito dai valori predefiniti per organizzazioni invitate: alzare ciò che riceve un cliente pagante o invitato non alza mai ciò che riceve uno sconosciuto.',
  'settings.admin.spend-ceiling.self-reg-budget-label': 'Budget run mensile (USD)',
  'settings.admin.spend-ceiling.self-reg-concurrency-label': 'Run simultanei massimi',
  'settings.admin.spend-ceiling.save': 'Salva',
  'settings.admin.spend-ceiling.toast-error-negative':
    'Il tetto di istanza non può essere negativo',
  'settings.admin.spend-ceiling.toast-error-budget':
    'Il budget di auto-registrazione deve essere un numero positivo',
  'settings.admin.spend-ceiling.toast-error-concurrency':
    'La concorrenza di auto-registrazione deve essere un numero intero positivo',
  'settings.admin.spend-ceiling.toast-error-forbidden':
    "Serve l'accesso da amministratore istanza per questo",
  'settings.admin.spend-ceiling.toast-error-save': 'Impossibile salvare',
  'settings.admin.spend-ceiling.toast-success': 'Tetto di spesa salvato',
} satisfies Dict;
