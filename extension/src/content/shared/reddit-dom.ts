export function findComposeTextarea(): HTMLTextAreaElement | null {
  return (document.querySelector('textarea[name="text"]') ??
    document.querySelector('textarea[placeholder*="message" i]')) as HTMLTextAreaElement | null;
}

export function findComposeSendButton(): HTMLButtonElement | null {
  const direct = document.querySelector('button[type="submit"]');
  if (direct) return direct as HTMLButtonElement;
  return (
    (Array.from(document.querySelectorAll('button')).find((b) =>
      /^send$/i.test(b.textContent?.trim() ?? ''),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

export function findCommentTextarea(): HTMLTextAreaElement | HTMLElement | null {
  return (
    (document.querySelector('textarea[name="text"]') as HTMLTextAreaElement | null) ??
    (document.querySelector('[contenteditable="true"][role="textbox"]') as HTMLElement | null)
  );
}

export function findCommentSubmitButton(
  root: ParentNode = document,
): HTMLButtonElement | null {
  const candidates = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[];
  return (
    candidates.find((b) => /comment|reply|post/i.test(b.textContent?.trim() ?? '')) ?? null
  );
}
