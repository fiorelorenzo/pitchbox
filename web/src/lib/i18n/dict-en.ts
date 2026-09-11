import type { Dict } from './types.js';

export const en = {
  // Shared across every session-less auth page (/login, /register, /reset,
  // /reset/[token]): identical wording on all four, so one key rather than
  // four copies that could drift.
  'auth.disabled-title': 'Authentication is disabled',
  'auth.disabled-seo-title': 'Authentication disabled',
  'auth.go-to-app': 'Go to Pitchbox',

  'login.seo-title': 'Sign in',
  'login.seo-description': 'Sign in to Pitchbox',
  'login.disabled-body':
    'This instance runs with PITCHBOX_AUTH off, so there is no account to sign in to. Set PITCHBOX_AUTH=on in your environment to enable sign-in.',
  'login.create-first-user-title': 'Create the first user',
  'login.sign-in-title': 'Sign in to Pitchbox',
  'login.first-user-hint':
    'No user exists yet. The credentials you enter below will create the admin account.',
  'login.username-label': 'Username',
  'login.password-label': 'Password',
  'login.create-button': 'Create',
  'login.sign-in-button': 'Sign in',
  'login.need-account': 'Need an account?',
  'login.create-account-link': 'Create one',
  'login.forgot-password-link': 'Forgot your password?',
  'login.error-create-failed': 'Could not create user',
  'login.error-invalid-credentials': 'Invalid credentials',

  'register.seo-title': 'Create an account',
  'register.seo-description': 'Create a Pitchbox account',
  'register.disabled-body':
    'This instance runs with PITCHBOX_AUTH off, so there is no account to create. Set PITCHBOX_AUTH=on in your environment to enable registration.',
  'register.closed-title': 'Registration is disabled',
  'register.invite-only-title': 'This deployment is invite-only',
  'register.closed-body':
    'Registration is disabled on this deployment. Ask its operator for an account.',
  'register.invite-only-body':
    'This deployment is invite-only. Ask an organization owner for an invite link to create an account.',
  'register.sign-in-instead-button': 'Sign in instead',
  'register.title': 'Create an account',
  'register.invited-body': 'You have been invited to join {org}. Create an account to accept.',
  'register.default-org': 'an organization',
  'register.plan-body': 'Continuing to {plan} ({interval}) after your account is created.',
  'register.billed-annually': 'billed annually',
  'register.billed-monthly': 'billed monthly',
  'register.email-label': 'Email',
  'register.already-have-account': 'Already have an account?',
  'register.sign-in-link': 'Sign in',
  'register.error-username-taken': 'That username is already taken',
  'register.error-email-taken': 'That email is already registered',
  'register.error-invite-invalid': 'This invite is no longer valid',
  'register.error-rate-limited': 'Too many attempts, try again shortly',
  'register.error-generic': 'Could not create account',
  'register.success-title': 'Account created',
  'register.success-verify-body':
    'Check your email to verify your address before you can start a run.',
  'register.creating-button': 'Creating…',
  'register.create-account-button': 'Create account',

  'invite.invalid-title': 'Invite invalid or expired',
  'invite.invalid-body': 'Ask the organization admin to issue a new invite link.',
  'invite.title': "You're invited",
  'invite.invited-by-body': '{inviter} invited you to join {org}.',
  'invite.invited-generic-body': 'You have been invited to join {org}.',
  'invite.default-org': 'this organization',
  'invite.accept-button': 'Accept invite',
  'invite.accepting-button': 'Accepting…',

  'reset.seo-title': 'Reset your password',
  'reset.seo-description': 'Request a password reset link',
  'reset.disabled-body':
    'This instance runs with PITCHBOX_AUTH off, so there is no account to reset a password for. Set PITCHBOX_AUTH=on in your environment to enable this.',
  'reset.sent-title': 'Check your email',
  'reset.sent-body':
    'If that address has a Pitchbox account, a reset link is on its way. It expires in 20 minutes.',
  'reset.back-to-sign-in': 'Back to sign in',
  'reset.title': 'Reset your password',
  'reset.body':
    "Enter the email on your account and we'll send you a link to choose a new password.",
  'reset.email-label': 'Email',
  'reset.send-button': 'Send reset link',
  'reset.sending-button': 'Sending…',
  'reset.error-too-many-attempts': 'Too many attempts',
  'reset.error-retry-in': 'Try again in {seconds}s',
  'reset.error-send-failed': 'Could not send reset link',

  'reset.confirm.seo-title': 'Choose a new password',
  'reset.confirm.seo-description': 'Choose a new Pitchbox password',
  'reset.confirm.title': 'Choose a new password',
  'reset.confirm.body':
    'At least 8 characters. This signs you in and signs out every other session on this account.',
  'reset.confirm.new-password-label': 'New password',
  'reset.confirm.confirm-password-label': 'Confirm new password',
  'reset.confirm.submit-button': 'Reset password',
  'reset.confirm.submitting-button': 'Resetting…',
  'reset.confirm.success-title': 'Password reset',
  'reset.confirm.success-body': 'Every other session on your account was signed out.',
  'reset.confirm.error-invalid-title': 'This link is no longer valid',
  'reset.confirm.error-invalid-body':
    'It may have expired or already been used, request a new one.',

  'brand.name': 'Pitchbox',

  'nav.aria-primary': 'Primary navigation',
  'nav.aria-open': 'Open navigation',
  'nav.aria-close': 'Close navigation',
  'nav.home': 'Home',
  'nav.inbox': 'Inbox',
  'nav.group-outreach': 'Outreach',
  'nav.projects': 'Projects',
  'nav.campaigns': 'Campaigns',
  'nav.playbooks': 'Playbooks',
  'nav.group-people': 'People',
  'nav.people': 'People',
  'nav.blocklist': 'Blocklist',
  'nav.group-insight': 'Insight',
  'nav.analytics': 'Analytics',
  'nav.audit': 'Audit',
  'nav.group-assistant': 'Assistant',
  'nav.companion': 'Companion',
  'nav.notifications': 'Notifications',
  'nav.settings': 'Settings',
  'nav.website': 'Website',
  'nav.docs': 'Docs',
  'nav.sign-out': 'Sign out',
  'nav.error-refresh-count': 'Could not refresh notification count',
  'nav.error-refresh-count-offline': 'Could not refresh notification count, check your connection',
  'nav.error-sign-out': 'Could not sign out. Please try again.',
  'nav.error-sign-out-offline': 'Could not sign out, check your connection.',

  'org-switcher.label': 'Organization',
  'org-switcher.organizations-label': 'Organizations',
  'org-switcher.organization-link': 'Organization',
  'org-switcher.create-link': 'Create organization',
  'org-switcher.create-description': 'Give your new workspace a name. You can invite people afterwards.',
  'org-switcher.name-label': 'Name',
  'org-switcher.url-prefix': 'URL:',
  'org-switcher.cancel': 'Cancel',
  'org-switcher.create-button': 'Create',
  'org-switcher.error-switch': 'Could not switch organization',
  'org-switcher.error-slug-taken': 'That URL is already taken, pick a different name',
  'org-switcher.error-invalid-name': 'Enter a valid name (at least 3 letters or numbers)',
  'org-switcher.error-create-generic': 'Could not create organization',
  'org-switcher.success-created': 'Created {name}',

  'command-palette.placeholder': 'Search drafts, contacts, campaigns, projects...',
  'command-palette.action-create-campaign': 'Create campaign',
  'command-palette.action-generate-token': 'Generate extension token',
  'command-palette.action-open-settings': 'Open Settings',
  'command-palette.heading-actions': 'Actions',
  'command-palette.searching': 'Searching...',
  'command-palette.no-results': 'No results found.',
  'command-palette.error-unavailable': 'Search is temporarily unavailable.',
  'command-palette.error-rejected': 'Search request was rejected.',
  'command-palette.error-unavailable-offline':
    'Search is temporarily unavailable, check your connection.',
  'command-palette.heading-drafts': 'Drafts',
  'command-palette.heading-contacts': 'Contacts',
  'command-palette.heading-campaigns': 'Campaigns',
  'command-palette.heading-projects': 'Projects',

  'billing-banner.read-only-title': 'Account is read-only since {date}',
  'billing-banner.read-only-body':
    'A payment failed and nothing succeeded during the grace period, so new runs, suggestions, accepts, projects, campaigns, invites and devices are refused. Everything already here stays readable - fix the payment method in the {link} to restore service.',
  'billing-banner.customer-portal-link': 'customer portal',
  'billing-banner.grace-title': 'Payment failed - grace period until {date}',
  'billing-banner.grace-body':
    'Your plan keeps working normally until then. Update your payment method in the {link} before {date} to avoid the account going read-only.',

  'chat-sync-banner.title': 'Reddit Chat sync paused',
  'chat-sync-banner.body':
    'The browser extension\'s Matrix token is no longer accepted. Open {link} and reload the page so the extension can capture a fresh token. New incoming chat replies will not appear until then.',

  'extension-nudge.no-device-title': 'Get faster reply detection with the browser extension',
  'extension-nudge.no-device-body':
    'No browser extension is paired with this workspace yet. Install it and pair a device from Settings > Browser extension so incoming Reddit replies show up here automatically.',
  'extension-nudge.stale-title': 'Your browser extension has gone quiet',
  'extension-nudge.stale-body':
    "No paired device has reported in for a while. Open Reddit in the browser it's installed in, or pair a new device from Settings > Browser extension, so incoming replies keep syncing.",
  'extension-nudge.dismiss': 'Dismiss',

  'onboarding-banner.aria-label': 'Setup',
  'onboarding-banner.title': 'Finish setting up Pitchbox',
  'onboarding-banner.progress-count': '{done} of {total} done',
  'onboarding-banner.next-label': 'Next: {step}.',
  'onboarding-banner.continue-setup': 'Continue setup',
  'onboarding-banner.skip': 'Skip for now',
  'onboarding-banner.aria-progress': 'Setup progress',

  'onboarding.step.organization.title': 'Name your organization',
  'onboarding.step.organization.description':
    'It started out named after your account. Give it the name your team or company actually uses.',
  'onboarding.step.organization.cta': 'Rename organization',
  'onboarding.step.verify_email.title': 'Verify your email address',
  'onboarding.step.verify_email.description': 'Confirm the address on file before you can start a run.',
  'onboarding.step.verify_email.cta': 'Verify email',
  'onboarding.step.project.title': 'Create a project with a source',
  'onboarding.step.project.description':
    'Give the agent something to write about - a folder, a repo, or a website.',
  'onboarding.step.project.cta': 'Create a project',
  'onboarding.step.account.title': 'Connect a platform account',
  'onboarding.step.account.description':
    'Add the Reddit, Hacker News, or Mastodon account outreach will run from.',
  'onboarding.step.account.cta': 'Connect an account',
  'onboarding.step.extension.title': 'Install the browser extension',
  'onboarding.step.extension.description':
    'Pair it once and it will help you draft comments and detect replies on a real page.',
  'onboarding.step.extension.cta': 'Get the extension',
  'onboarding.step.first_draft.title': 'Reach a first draft',
  'onboarding.step.first_draft.description':
    'Run a campaign and let the agent produce something for you to review.',
  'onboarding.step.first_draft.cta': 'Run a campaign',

  'onboarding.page.seo-title': 'Set up Pitchbox',
  'onboarding.page.seo-description':
    'Name your organization, connect an account, and reach your first draft.',
  'onboarding.page.header-description':
    'A few steps to get from an empty workspace to your first draft.',
  'onboarding.page.review-button': 'Review',
  'onboarding.page.completed-title': "You're all set",
  'onboarding.page.completed-body':
    'Every step of setup is done. Run it again any time from Settings if you want to walk through it once more.',
  'onboarding.page.go-to-dashboard': 'Go to the dashboard',
  'onboarding.page.skipped-title': 'Setup is skipped',
  'onboarding.page.skipped-body': 'You can start it again whenever you want, from here or from Settings.',
  'onboarding.page.start-again': 'Start setup again',

  'settings.onboarding.seo-title': 'Settings - Onboarding',
  'settings.onboarding.seo-description':
    'The guided first-run setup: its status, and starting it again.',
  'settings.onboarding.title': 'Onboarding',
  'settings.onboarding.description': 'The guided setup that ran on first sign-in.',
  'settings.onboarding.status-label': 'Status',
  'settings.onboarding.status.not-started': 'Not started',
  'settings.onboarding.status.in-progress': 'In progress',
  'settings.onboarding.status.completed': 'Completed',
  'settings.onboarding.status.skipped': 'Skipped',
} satisfies Dict;
