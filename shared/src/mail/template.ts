/**
 * Turns a subject and a plain-text body into a `RenderedMail` carrying both
 * a text part and an HTML alternative. Every template (#509's password
 * reset, #510's invite) is authored as plain text only and rendered through
 * this - a reset mail that lands in spam because it had no text part, or
 * had an HTML part someone forgot to keep in sync with the text, is a
 * broken feature, not a cosmetic gap. Deriving the HTML mechanically from
 * the one authored text is what keeps that impossible rather than merely
 * discouraged.
 */
export type RenderedMail = {
  subject: string;
  text: string;
  html: string;
};

export function renderPlainTextMail(subject: string, text: string): RenderedMail {
  const trimmedSubject = subject.trim();
  const trimmedText = text.trim();
  if (!trimmedSubject) throw new Error('renderPlainTextMail: subject must not be empty');
  if (!trimmedText) throw new Error('renderPlainTextMail: text must not be empty');
  return { subject: trimmedSubject, text: trimmedText, html: textToHtml(trimmedText) };
}

function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return (
    '<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, ' +
    'sans-serif; line-height: 1.5; color: #111;">\n' +
    paragraphs +
    '\n</body></html>'
  );
}
