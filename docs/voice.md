# Why a draft doesn't read like ChatGPT

Three separate mechanisms do this work. A measurement of your own writing
catches what actually repeats in it. A checker runs after the model and can
refuse to accept what it wrote. A hard boundary limits what the extension is
even allowed to read in the first place. None of the three is a prompt
asking the model to "sound human" - each is code you can read, named below
next to the file it lives in.

## What the system reads about you

Two tables hold what Pitchbox knows about you specifically: `operator_profiles`
(your persona - handle, headline, about, experience) and
`operator_voice_samples` (your own recent posts). Both are populated by the
Chrome extension's content script reading whatever your own browser already
rendered on your own `/in/<slug>` and `recent-activity` pages
(`extension/src/content/linkedin-profile-capture.ts`), and both are editable
by hand from the **Companion** section of the dashboard - the persona at
`/companion`, the voice samples (excludable one by one) and the derived
summary at `/companion/voice`.

The boundary that makes this safe: no code path in this product ever issues a
request toward linkedin.com. The extension reads the DOM already in front of
you and posts what it found to Pitchbox's own backend - the profile-capture
script's own comment spells out why the request path is even named apart from
the word "linkedin" (`OPERATOR_PROFILE_PATH`, same file), so a static scanner
can tell "posts to our backend" from "fetches LinkedIn" on sight. That
scanner is real, not a promise: `pnpm run test:linkedin-compliance`
(`tests/compliance/linkedin-boundary.test.ts`) parses the built extension and
fails on six things - a fetch toward linkedin.com or licdn, a cookie or
storage read inside a LinkedIn content script, a synthetic click or submit on
a LinkedIn element, an alarm reachable from LinkedIn code, a network call
anywhere in the LinkedIn platform directory, and the LinkedIn host permission
turning into a blanket grant instead of the optional one it has to stay. It
is a required CI check, and it inspects the real manifest and source, not a
checklist someone filled in.

## How the voice profile is derived

`shared/src/assist/voice-profile.ts` is a measurement, not a model call. It
reads your voice samples, your sent messages, your sent drafts and your
project templates, and counts what actually repeats:

- Sentence length, and how much it varies from one piece of writing to the next.
- Paragraph shape.
- Punctuation habits.
- How often you write in the first or second person.
- How often you hedge.
- Which words you reuse.
- The split between English and Italian.

Every one of those is a countable property of text that already exists,
computed with no I/O and no model in the loop.

The floor is explicit: `MIN_ITEMS_TO_DERIVE` is 3. Below that, the function
returns nothing measured, because two posts sharing an opening word is a
coincidence, not a habit - a smaller corpus can't tell the difference and the
code doesn't pretend otherwise. Below the floor, `shared/src/assist/voice-defaults.ts`
supplies a fallback instead: a short, named set of rules ("open with a short
first sentence," "no tricolons," "plain words") that is stated as a default
in its own text, never phrased as if it came from reading anything you wrote.
`shared/src/operator-voice-profile.ts`'s `resolveVoiceProfile` is what keeps
the two from blurring together - every axis it hands back is labelled
`measured` or `default`, never both, so nothing downstream can present a
guess as a fact about you.

## The house style, and why it is code

`shared/src/house-style.ts` holds the prose every playbook carries verbatim,
under the heading `## House style: write like a human`. `shared/src/style-check.ts`
is the part that actually runs against what a draft came back with. It
catches, among other things:

- Em dashes, curly quotes and curly apostrophes, the single-character
  ellipsis, non-breaking spaces - e.g. `word — word` becomes `word, word`.
- Filler openers - `"Great post!"`, `"Thanks for sharing"`.
- Puffery words - `leverage`, `unlock`, `delve`, `game-changer`.
- Wrap-up closers - `"at the end of the day"`, `"hope this helps"`.
- The "not just X but Y" construction.
- A rhetorical question as the opening sentence.
- Tricolons (three items closed with an Oxford comma and "and").
- Hashtag stacks and emoji used as bullet points.

There are two kinds of finding, and they are handled differently.
A character-level finding (an em dash, a curly quote) is repaired
mechanically by `applyMechanicalRepairs` - a string substitution, no model
call. A structural finding (a tricolon, a rhetorical opener) can't be fixed
that way, so `enforceHouseStyle` sends the draft back to the model exactly
once, naming the exact span that failed, and checks the result again. A
finding still present after that round trip is never silently dropped: it
travels with the draft so a human sees it rather than a cleaned-up draft
that quietly still has the tell.

## What you can steer

- **Tone.** `Settings → LinkedIn assist` sets a default register for every
  suggestion, chosen from six presets:
  - Match the room - the default, mixing the post's own register with your voice.
  - Professional.
  - Plain.
  - Warm.
  - Technical.
  - In my own words - a free-text note you write yourself.
- **Retune, per suggestion.** The panel itself offers Drier, Warmer or
  Shorter on the draft currently on screen, without touching the stored
  tone setting - it's a one-off request on that call, not a preference.
- **Voice samples.** Any post under `/companion/voice` can be excluded from
  the corpus without deleting it, so a capture you don't want feeding the
  measurement doesn't just come back on the next page load.
- **The derived summary itself.** You can hand-edit it, and a manual edit
  survives the next refresh until you explicitly reset it back to derived
  (`resetVoiceProfileToDerived` in `shared/src/operator-voice-profile.ts`).

## What it will not do

It does not send anything. The extension writes drafted text into the
composer already open on the page (`insertComposerText` in
`extension/src/content/linkedin-comment.ts`) and copies it to the clipboard
as a fallback - you press LinkedIn's own submit button, always.

It does not imitate anyone but you. Every corpus item the voice measurement
reads is scoped to your own organization - your own samples, your own sent
messages, your own sent drafts.

It does not claim to know your voice from nothing. Below the three-item
floor it says so in its own text rather than guessing: "No writing on file
yet, so this is a default style, not a measurement."
