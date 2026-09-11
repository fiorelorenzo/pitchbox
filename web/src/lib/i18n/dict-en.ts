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
} satisfies Dict;
