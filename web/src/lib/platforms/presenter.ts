export type DraftLike = {
  kind: string;
  targetUser: string | null;
  metadata: Record<string, unknown> | null;
};

export type Presenter = {
  primaryLabel(d: DraftLike): string;
  userLabel(handle: string): string;
  eventLabel(event: string): string | null;
  replyActionLabel(): string;
};

// Honest, punctuation-free fallback when a draft has no recipient at all.
// Platform presenters override this with something more specific (see
// reddit/presenter.ts); this generic one only has the draft kind to go on.
function fallbackLabel(kind: string): string {
  switch (kind) {
    case 'dm':
      return 'DM';
    case 'post':
      return 'Post';
    case 'post_comment':
      return 'Comment';
    case 'comment_reply':
      return 'Reply';
    default:
      return 'Draft';
  }
}

const generic: Presenter = {
  primaryLabel: (d) => (d.targetUser ? `@${d.targetUser}` : fallbackLabel(d.kind)),
  userLabel: (handle) => `@${handle}`,
  eventLabel: () => null,
  replyActionLabel: () => 'Reply',
};

const registry: Record<string, Presenter> = {};

export function registerPresenter(slug: string, p: Presenter): void {
  registry[slug] = p;
}

export function getPresenter(slug: string | null | undefined): Presenter {
  if (!slug) return generic;
  return registry[slug] ?? generic;
}

// Platform slugs the Chrome extension can drive end-to-end: it injects a
// content script into the platform's own compose/submit page (see
// extension/manifest.config.ts `content_scripts`) that arms the send button
// and reports back, flipping the draft to `sent` automatically. Every other
// platform slug (hackernews, or mastodon outside auto-post mode) has no
// matching content script, so the human has to open the link, send it
// themselves, and click "Mark as sent".
const EXTENSION_AUTOMATED_PLATFORMS = new Set(['reddit']);

export function isExtensionAutomated(platformSlug: string | null | undefined): boolean {
  return platformSlug != null && EXTENSION_AUTOMATED_PLATFORMS.has(platformSlug);
}
