import type { Dict } from './types.js';

// LOR-264: every human sentence a server route or an outbound mail sends
// that a person actually reads. The machine-readable `error`/`refused` code
// next to each of these in its route never lives here and never changes
// shape when this file does - see docs/design/DECISIONS.md for the rule
// this catalogue exists to enforce. Where `web/src/routes/api/extension/**`
// and the plan/quota refusals it inherits from `@pitchbox/shared/plans` and
// `@pitchbox/shared/usage` answer key-only (no `message` field at all), that
// is the deliberate per-endpoint choice recorded there too: the extension
// already carries its own `assist.refusal.*` catalogue
// (`extension/src/lib/i18n/dict-en.ts`) and renders it in whatever locale the
// panel itself is running in, so a server-guessed prose string would be
// redundant at best and wrong at worst.
export const en = {
  // Runner availability (#219/#410): one message, four call sites
  // (POST/PATCH campaigns, POST/PATCH projects) - an explicit runner this
  // deployment's edition cannot launch, named so the caller knows which one.
  'api.runner_not_allowed':
    'Agent runner "{runner}" is not available in this deployment\'s edition.',

  // POST /api/auth/register (#505): the instance-wide registration switch.
  // Own sentences (not a bare 403) so the register page can explain what
  // happened instead of a generic failure.
  'api.register.registration_closed':
    'Registration is disabled on this deployment. Ask its operator for an account.',
  'api.register.invite_required':
    'This deployment is invite-only. Ask an organization owner for an invite link.',

  // PATCH /api/projects/[id]: the free-text voice tone is the only option
  // whose instruction is the operator's own words, so choosing it with no
  // notes would silently override the org tone with an empty instruction.
  'api.projects.custom_tone_required':
    'Describe the tone you want, or pick "Use organization default".',

  // POST /api/projects/[id]/extraction-uploads: every refusal along the
  // upload path, in the order the route checks them.
  'api.uploads.multipart_parse_failed': 'multipart parse failed',
  'api.uploads.too_many_files': 'max {max} files',
  'api.uploads.no_files': 'no files in request',
  'api.uploads.file_too_large': '{rel} exceeds per-file {max}B cap',
  'api.uploads.total_too_large': 'total upload exceeds {max}B cap',
  'api.uploads.bad_path': 'bad path "{rel}": {reason}',
  // The `{reason}` fragment `bad_path` interpolates - kept as their own keys
  // rather than baked into `bad_path` itself so each is independently
  // translatable and testable, mirroring `isAcceptableRelPath`'s own reason
  // codes.
  'api.uploads.reason.empty_path': 'empty path',
  'api.uploads.reason.absolute_path': 'absolute path',
  'api.uploads.reason.invalid_characters': 'invalid characters',
  'api.uploads.reason.parent_traversal': 'parent traversal',
  'api.uploads.reason.path_too_long': 'path too long',
  'api.uploads.no_allowed_files': 'no allowed files in upload',
  'api.uploads.path_escaped_root': 'path resolution escaped root: {rel}',

  // Outbound mail (`@pitchbox/shared/mail/templates.ts`). Subject and body
  // are separate keys throughout so a transport that only shows one still
  // gets a complete, actionable sentence rather than half of one.
  'mail.password_reset.subject': 'Reset your Pitchbox password',
  'mail.password_reset.body':
    'Someone asked to reset the password on this Pitchbox account.\n\n' +
    'Open this link within 20 minutes to choose a new one:\n{resetUrl}\n\n' +
    "If this wasn't you, ignore this message - your password stays the same.",

  'mail.verify_email.subject': 'Verify your Pitchbox email address',
  // Sent once, right after a token-less registration - the account exists
  // but has never verified an address yet.
  'mail.verify_email.register_body':
    'Welcome to Pitchbox. Confirm this address to start running campaigns.\n\n' +
    'Open this link within 48 hours to verify:\n{verifyUrl}\n\n' +
    "You can sign in and look around before you verify - you just can't start " +
    "a run yet. If you didn't create this account, ignore this message.",
  // Sent by the signed-in caller's own self-service resend - no welcome
  // line, since the account already exists and this is not its first mail.
  'mail.verify_email.resend_body':
    'Confirm this address to start running campaigns.\n\n' +
    'Open this link within 48 hours to verify:\n{verifyUrl}\n\n' +
    "If you didn't request this, ignore this message.",

  'mail.invite.subject': "You're invited to join {orgName} on Pitchbox",
  'mail.invite.body':
    "You've been invited to join {orgName} on Pitchbox as {role}.\n\n" +
    'Accept the invite: {url}\n\n' +
    "This invite expires on {expiresAt}. If you weren't expecting this, you can ignore this email.",

  // Usage-threshold notifications (LOR-288, `shared/src/usage-notifications.ts`):
  // a `notifications` row is organization-wide and its readers do not all
  // share one locale, so these render at read time in the reader's own
  // locale (`shared/src/notifications.ts`'s `renderNotification`) rather
  // than once at write time - see docs/design/DECISIONS.md. One key pair
  // per metered axis rather than one template with an interpolated label,
  // since the label itself needs translating and `t()`'s interpolation is
  // flat string substitution, not a nested lookup.
  'usageNotification.title.runs': '{threshold}% of your agent runs limit',
  'usageNotification.title.suggestions': '{threshold}% of your assist suggestions limit',
  'usageNotification.title.projects': '{threshold}% of your projects limit',
  'usageNotification.title.seats': '{threshold}% of your seats limit',
  'usageNotification.title.extensionDevices': '{threshold}% of your paired devices limit',
  'usageNotification.title.costUsd': '{threshold}% of your model spend limit',

  'usageNotification.body.runs':
    'You have used {usedText} of {limitText} agent runs for the period ending {periodEnd}. ' +
    'Upgrade your plan from Settings > Billing before it starts refusing requests.',
  'usageNotification.body.suggestions':
    'You have used {usedText} of {limitText} assist suggestions for the period ending {periodEnd}. ' +
    'Upgrade your plan from Settings > Billing before it starts refusing requests.',
  'usageNotification.body.projects':
    'You have used {usedText} of {limitText} projects for the period ending {periodEnd}. ' +
    'Upgrade your plan from Settings > Billing before it starts refusing requests.',
  'usageNotification.body.seats':
    'You have used {usedText} of {limitText} seats for the period ending {periodEnd}. ' +
    'Upgrade your plan from Settings > Billing before it starts refusing requests.',
  'usageNotification.body.extensionDevices':
    'You have used {usedText} of {limitText} paired devices for the period ending {periodEnd}. ' +
    'Upgrade your plan from Settings > Billing before it starts refusing requests.',
  'usageNotification.body.costUsd':
    'You have used {usedText} of {limitText} model spend for the period ending {periodEnd}. ' +
    'Upgrade your plan from Settings > Billing before it starts refusing requests.',
} satisfies Dict;
