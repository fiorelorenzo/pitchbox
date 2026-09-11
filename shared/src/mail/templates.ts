/**
 * The outbound mail content itself (LOR-264): what a password reset, a
 * verification link and an org invite actually say, in the recipient's
 * language. `./template.ts` only turns a subject+text pair into a rendered
 * `RenderedMail` (text plus its derived HTML); this module is what decides
 * the subject and the text, resolved through `@pitchbox/shared/messages` so
 * the sentence moves with the locale while the surrounding URL/name/date
 * arguments stay exactly what the caller supplies.
 *
 * Locale sourcing is the caller's job, not this module's - a route with a
 * live session passes `event.locals.locale` (already the account's own
 * preference, once LOR-262 attaches it in hooks.server.ts); the
 * forgot-password route has no session behind the request at all and passes
 * the target account's own stored locale instead. See each call site's own
 * comment for why.
 */
import { renderPlainTextMail, type RenderedMail } from './template.js';
import { t, type Locale } from '../messages/index.js';

export function passwordResetMail(
  locale: Locale | null | undefined,
  resetUrl: string,
): RenderedMail {
  return renderPlainTextMail(
    t(locale, 'mail.password_reset.subject'),
    t(locale, 'mail.password_reset.body', { resetUrl }),
  );
}

/**
 * `variant` picks the closing paragraph: `register` welcomes a brand-new
 * account on its first mail, `resend` addresses an account that already
 * exists and already got one.
 */
export function verifyEmailMail(
  locale: Locale | null | undefined,
  variant: 'register' | 'resend',
  verifyUrl: string,
): RenderedMail {
  const bodyKey =
    variant === 'register' ? 'mail.verify_email.register_body' : 'mail.verify_email.resend_body';
  return renderPlainTextMail(
    t(locale, 'mail.verify_email.subject'),
    t(locale, bodyKey, { verifyUrl }),
  );
}

export function inviteMail(
  locale: Locale | null | undefined,
  args: {
    to: string;
    orgName: string;
    role: string;
    origin: string;
    token: string;
    expiresAt: Date;
  },
): RenderedMail & { to: string } {
  const url = `${args.origin}/invite/${args.token}`;
  const rendered = renderPlainTextMail(
    t(locale, 'mail.invite.subject', { orgName: args.orgName }),
    t(locale, 'mail.invite.body', {
      orgName: args.orgName,
      role: args.role,
      url,
      expiresAt: args.expiresAt.toDateString(),
    }),
  );
  return { to: args.to, ...rendered };
}
