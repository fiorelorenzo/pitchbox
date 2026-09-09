import * as nodemailer from 'nodemailer';
import type { MailMessage, MailTransport } from './base.js';

export type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
};

/**
 * Real transport speaking SMTP directly (via nodemailer) - the self-host
 * escape hatch for a deploy that has its own mail server or a
 * provider-neutral SMTP relay instead of a Resend account.
 */
export class SmtpMailTransport implements MailTransport {
  readonly name = 'smtp';
  private readonly transporter: nodemailer.Transporter;
  private readonly defaultFrom: string;

  constructor(opts: SmtpOptions, defaultFrom: string) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: opts.user && opts.pass ? { user: opts.user, pass: opts.pass } : undefined,
    });
    this.defaultFrom = defaultFrom;
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: message.from ?? this.defaultFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
