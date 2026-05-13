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

const generic: Presenter = {
  primaryLabel: (d) => (d.targetUser ? `@${d.targetUser}` : '-'),
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
