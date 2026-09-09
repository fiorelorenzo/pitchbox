/**
 * Platform-agnostic interface for sending a single outbound email. Shaped
 * like the other pluggable boundaries in this repo (`AgentRunner`,
 * `ReplyReader`): one interface, a null implementation that is always safe
 * to run, and a config-driven selection (`./registry.ts`) between it and a
 * real transport.
 *
 * This module is deliberately just the transport. It sends whatever
 * `MailMessage` it is given; deciding what a password reset or an invite
 * email says is #509's and #510's job, not this one's.
 */
export type MailMessage = {
  /** Recipient address. */
  to: string;
  /**
   * Sender address, `"Name <addr>"` or bare `addr`. Optional: a transport
   * falls back to its own configured default (`MAIL_FROM`) when omitted.
   */
  from?: string;
  subject: string;
  /** Plain-text body. Always present - see `./template.ts`. */
  text: string;
  /** HTML alternative. Always present - see `./template.ts`. */
  html: string;
};

export interface MailTransport {
  /** Transport identifier, for logging - "null", "resend", or "smtp". */
  readonly name: string;
  /**
   * Send `message`. A real transport may throw on failure (network error,
   * provider rejection); it does not swallow one. Nothing today retries or
   * queues a failed send - that lands with whichever of #509/#510 first
   * wires this into a user-facing flow.
   */
  send(message: MailMessage): Promise<void>;
}

/**
 * Null implementation: logs what it would have sent and drops it. This is
 * the default transport - a self-host with nothing configured keeps
 * working, and a reset/invite request that nobody will ever see still shows
 * up somewhere a person debugging it can find it (the process log), rather
 * than throwing or silently doing nothing.
 */
export class NullMailTransport implements MailTransport {
  readonly name = 'null';

  async send(message: MailMessage): Promise<void> {
    console.log(
      `[mail] null transport - would send "${message.subject}" to ${message.to}:\n${message.text}`,
    );
  }
}
