# The two languages, and what each one controls

Pitchbox has two independent language settings. One decides what language you
read the dashboard, the side panel and the in-page panel in. The other
decides what language a drafted post or reply is written in. They share no
code path, and setting one does nothing to the other - an Italian dashboard
producing an English reply to an English post is the intended behaviour, not
a bug. Conflating the two is the easiest way to misread this product, so this
page states the boundary once, plainly, and names the mechanism behind each
side.

## The interface locale

This is what language you see labels, buttons and server-sent messages in.
Two values are supported, `en` and `it` (`web/src/lib/i18n.ts`'s `LOCALES`),
and one function decides which applies to a given request,
`resolveLocale` in that same file, called once per request from
`web/src/hooks.server.ts` and stashed on `event.locals.locale` so no two
loaders or components can disagree with each other. The precedence, in
order:

1. **The signed-in account's stored preference** (`users.locale`).
2. **The `pitchbox_locale` cookie** - the fallback for a visitor who has no
   account yet: `/login`, `/register`, `/invite/<token>` and `/reset` are all
   read by someone `resolveLocale` cannot look up a stored preference for.
3. **`Accept-Language`**, negotiated against the supported set
   (`negotiateLocale`).
4. **English**, when nothing above resolves.

The override is a single account setting, not one per surface. It lives in
`users.locale`, one row per person regardless of which organization their
session is currently active in, and both write paths update the same column
through `shared/src/auth.ts`'s `setUserLocale`: the dashboard's own
`POST /api/auth/locale` (session-authenticated, self-service) and the Chrome
extension's `POST /api/extension/locale` (device-token authenticated, called
the moment the extension's own language picker changes). That shared column
is what lets the dashboard, the side panel and the in-page panel (both the
comment-assist and post-assist variants) agree on one language: every one of
those surfaces polls `GET /api/extension/linkedin-assist`, which returns the
account's stored locale alongside the assist state it was already polling
for, and every reader applies it through the same
`applyAccountLocale` helper (`extension/src/lib/account-locale.ts`) rather
than deciding on its own.

A device with no account bound to it - a self-hosted install with auth off,
or a device paired by redeeming a one-time pairing code rather than through
the session-carrying auto-pair flow - reports `locale: null` from that same
endpoint. `applyAccountLocale` treats `null` as a no-op, leaving whatever the
extension already had (its own `chrome.storage` cache, or Chrome's own UI
language as the very first fallback) untouched. There is no per-org or
per-device default invented to fill the gap: an account preference either
exists or it doesn't, the same way `resolveLocale`'s own precedence never
guesses past its four defined steps.

## The drafted text's language

This is the language a comment, reply, DM or post actually gets written in,
and it has nothing to do with the interface locale above. The decision is
made in one function, `resolveDraftLanguage` in
`shared/src/assist/suggest-prompt.ts`, with a two-step precedence:

1. **An explicit pin**, when the caller supplied one. For a campaign, that
   pin is `campaign.config.voice.language` (`en` or `it`,
   `shared/src/campaigns/scenario-schemas.ts`'s `draftingVoiceShape`), read
   once per batch by `cli/src/commands/drafts.ts`'s
   `extractVoiceLanguagePin` and threaded through to both the prompt
   (`resolveDraftLanguage`'s `pin` argument) and the quality scorer's
   `expectedLanguage`. An operator who set one meant it: the pin outranks
   both the post being answered and the operator's own writing habits.
2. **The post being answered**, when `classifyLanguage`
   (`shared/src/assist/voice-profile.ts`) can read a language off it with
   real confidence. The person who wrote the post is the one who reads the
   reply, so their language wins over the operator's own corpus - that is
   the entire reason this function exists.

Absent both - no pin, and a post `classifyLanguage` cannot confidently read
(too short, genuinely bilingual, or no markers either way) - the prompt adds
no language instruction at all, rather than guessing a fourth time. A
proactive post with nothing to answer (`hn-poster`, `reddit-poster`,
`linkedin-poster`, `mastodon-poster`) has no post to match either, so with no
pin it falls back to whatever language the operator's own voice profile is
actually written in; every poster playbook states this explicitly, and every
one of them also states that the dashboard's own interface language has
nothing to do with what gets posted.

The worked example that makes the boundary concrete: set the dashboard to
Italian and go answer an English post with no campaign pin. The reply comes
back in English, because `resolveDraftLanguage` reads the post's language,
not `event.locals.locale`, and nothing in its call path ever looks at the
interface locale. Reading the dashboard in Italian while it drafts in English
is not a bug to file; it is the two axes doing exactly what they are each
built to do.

## The one gap today

The pin reaches the prompt (`resolveDraftLanguage`) and the quality scorer
(`shared/src/quality-judge.ts`'s `computeDeterministicQuality`, via its own
`expectedLanguage` argument, so a correctly-pinned Italian draft answering an
English post scores a language match rather than a manufactured mismatch).
It does not yet reach the house-style checker: `shared/src/style-check.ts`'s
`checkStyle` takes a single `text` argument and no language of its own,
so its bilingual phrase-list rules (`scanBilingual`, and `FILLER_OPENER_RULE`'s
own dispatch) still call `classifyLanguage` on the finished draft body to
decide which phrase list to run, rather than being told what the pin
already resolved. A pinned-Italian reply that `classifyLanguage` alone
misreads as English - not an edge case on this product's most common output
shape, a short reaction of a handful of words - is checked against the wrong
list, silently. This is tracked and being fixed in the same release
(LOR-291); the prompt and the scorer are not affected, only the mechanical
style check's choice of which phrase list to run.
