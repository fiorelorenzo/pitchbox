import { Resend } from 'resend';
import type { MailMessage, MailTransport } from './base.js';

/**
 * Real transport backed by Resend (https://resend.com). Already in use on
 * canonry-landing, so it is the boring choice here rather than a new
 * provider to learn.
 */
export class ResendMailTransport implements MailTransport {
  readonly name = 'resend';
  private readonly client: Resend;
  private readonly defaultFrom: string;

  constructor(apiKey: string, defaultFrom: string) {
    this.client = new Resend(apiKey);
    this.defaultFrom = defaultFrom;
  }

  async send(message: MailMessage): Promise<void> {
    const { error } = await this.client.emails.send({
      from: message.from ?? this.defaultFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    if (error) {
      throw new Error(`resend send to ${message.to} failed: ${error.name} - ${error.message}`);
    }
  }
}
