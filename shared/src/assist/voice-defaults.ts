// shared/src/assist/voice-defaults.ts
//
// #571: what the model is told about "how the operator writes" before there
// is enough of the operator's own writing to measure it honestly
// (`measureVoiceCorpus`'s own MIN_ITEMS_TO_DERIVE floor, `voice-profile.ts`).
// A new user has nothing on file, and the fallback used to be a single
// "professional register" line plus the house style section - not enough to
// keep a draft from sounding like every other LinkedIn comment.
//
// This is not a second derivation path, and it is not shaped like one on
// purpose: `DefaultVoiceProfile` shares no fields with `VoiceMeasurement`,
// so nothing here can be mistaken for something that was measured.
// `resolveVoiceProfile` (`../operator-voice-profile.ts`) is the only thing
// that reaches for this object, and only once the corpus is too thin to
// measure - it marks every axis it hands out as 'default', never
// 'measured'. One named object, so a caller has one thing to render or
// override, not sentences scattered through a prompt builder.

export type DefaultVoiceProfile = {
  /** One human-readable paragraph a prompt or a Settings page can show
   * verbatim, the same shape `describeVoiceProfile` returns for a real
   * measurement - but stated as a default, never phrased as if it were
   * read off the operator's own writing. */
  summary: string;
  /** The rules themselves, one sentence each, so a consumer can render
   * them as a list or fold them into a prompt without re-splitting prose. */
  rules: string[];
  /** Candidate words a default-sounding draft leaks. Overlaps house style's
   * puffery bans (`shared/src/style-check.ts`'s PUFFERY_WORDS and
   * WRAPUP_CLOSERS already cover "unlock" and "game-changer") and adds the
   * rest of the LinkedIn-specific ones #571 names ("humbled", "thrilled to
   * share", "this resonates") that the checker does not ban yet. Read-only
   * evidence for what "plain words" means here, never a second enforcement
   * path - `checkStyle` is still the only thing that blocks a draft. */
  avoidWords: string[];
};

export const DEFAULT_VOICE_PROFILE: DefaultVoiceProfile = {
  summary:
    "No writing on file yet, so this is a default style, not a measurement: a short first sentence with no preamble, one idea or a plain reaction - never both padded together to look more substantial - anchored to a concrete detail from the post when there is one to add, plain words, and a length that fits the room rather than a paragraph, matched to the post's own language and register rather than a house tone.",
  rules: [
    'Open with a short first sentence: no preamble, no restating the post, no "Great post!".',
    'No tricolons, no "not just X but Y", no rhetorical question as an opener.',
    'No wrap-up closer that summarises what was just said.',
    'Plain words: avoid the candidates in avoidWords.',
    "One idea per comment, or none at all: a short reaction anchored to the post's own tone is a complete comment, not a placeholder for one that says more.",
    "Match the post's own language and register rather than a house tone.",
    'Length that fits the room: about as long as the median visible comment under the post, not a paragraph.',
  ],
  avoidWords: [
    'leverage',
    'seamless',
    'robust',
    'comprehensive',
    'delve',
    'unlock',
    'elevate',
    'game-changer',
    'humbled',
    'thrilled to share',
    'this resonates',
  ],
};
