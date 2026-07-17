import { NullReplyReader, type ReplyReader } from '@pitchbox/shared/platforms/reply-reader';
import { MastodonReplyReader, type MastodonClient } from '@pitchbox/shared/platforms/mastodon';

/**
 * Resolves the Mastodon client for an account handle. Per-account credential
 * storage (instance URL + encrypted access token) is not wired up yet, so
 * this throws for now - the reply-poller catches and logs it per group,
 * which is harmless while no Mastodon account exists. Replace this with a
 * real resolver once account credentials land.
 */
function unconfiguredMastodonClient(accountHandle: string): MastodonClient {
  throw new Error(
    `no Mastodon client configured for account "${accountHandle}" - account credentials are not wired up yet`,
  );
}

/**
 * Platform slug → reply reader. We register a NullReplyReader for every platform
 * we know about until a real implementation lands. Swap in the real reader here
 * when ready; the poller picks up the change without any other code edits.
 */
const readers = new Map<string, ReplyReader>([
  ['reddit', new NullReplyReader('reddit')],
  ['mastodon', new MastodonReplyReader(unconfiguredMastodonClient)],
]);

export function getReplyReader(platformSlug: string): ReplyReader | null {
  return readers.get(platformSlug) ?? null;
}

export function registerReplyReader(reader: ReplyReader): void {
  readers.set(reader.platform, reader);
}

/**
 * Platform slugs backed by a real (non-Null) reply reader. The poller only
 * polls these - a NullReplyReader is inert by design (e.g. Reddit's reply
 * detection runs through the Chrome extension instead; see AGENTS.md).
 */
export function getActiveReplyReaderPlatforms(): string[] {
  return [...readers.entries()]
    .filter(([, reader]) => !(reader instanceof NullReplyReader))
    .map(([slug]) => slug);
}
