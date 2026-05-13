# Hacker News

**Setup.** Add an HN account in **Settings → Accounts** with the platform `hackernews` and your `username`. No password or token is stored - HN has no public auth API for outreach, so you sign in to news.ycombinator.com in your browser and Pitchbox only tracks the handle.

**Scope.** Pitchbox uses the public Firebase HN API (`hacker-news.firebaseio.com/v0`) to fetch `top`/`new`/`best`/`ask`/`show` listings. The `hn-commenter` playbook drafts `post_comment` drafts targeting HN story discussion pages. Compose URLs point at `news.ycombinator.com/reply?id=<itemId>`.

**Limitations.** No DMs (the platform doesn't have them) - only comment outreach. No reply tracking yet (M7+): the daemon uses the null reply reader for HN, so threads do not auto-advance to `replied`. Rate limits on the Firebase API are generous but not documented; the CLI caps `--limit` at 100 per call.
