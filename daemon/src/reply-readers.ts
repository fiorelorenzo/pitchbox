import { NullReplyReader, type ReplyReader } from '@pitchbox/shared/platforms/reply-reader';

/**
 * Platform slug → reply reader. We register a NullReplyReader for every platform
 * we know about until a real implementation lands. Swap in the real reader here
 * when ready; the poller picks up the change without any other code edits.
 */
const readers = new Map<string, ReplyReader>([['reddit', new NullReplyReader('reddit')]]);

export function getReplyReader(platformSlug: string): ReplyReader | null {
  return readers.get(platformSlug) ?? null;
}

export function registerReplyReader(reader: ReplyReader): void {
  readers.set(reader.platform, reader);
}
