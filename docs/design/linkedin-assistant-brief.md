# In-page LinkedIn assistant - approved brief

Status: approved 2026-09-03. Issue #310. The surface it describes is built in #311 (panel host), #312 (suggestion endpoint), #314 (comment assist) and #315 (post composer assist), per `docs/linkedin-integration-design.md`.

This is the contract the implementation is measured against. The three lines that no repo file could answer were decided in the same conversation and are recorded below with their reasoning, so an implementer never has to reconstruct them; the rules they create are also rows D10, D11 and D12 in `docs/design/DECISIONS.md`.

## The brief

```
Subject      A Pitchbox panel injected into linkedin.com that offers a suggested comment for
             the post the human is looking at, and a suggested post inside LinkedIn's own
             composer. It is the visible half of the real-time plane in
             docs/linkedin-integration-design.md, not a view onto campaigns.

Audience     The operator doing their own outreach: they know Pitchbox, they are mid-scroll on
             somebody else's product, and at the moment the panel appears they have not asked
             it for anything. They will judge a suggestion in about two seconds and reject
             most of them.

The job      Turn "this post deserves an answer" into an edited comment sitting in LinkedIn's
             own composer, without leaving the page. Request, read, edit, insert. The human
             still presses LinkedIn's button.

Palette      Repo tokens only, the .dark block, no new values (D1, D2, D5): --background
             oklch(0.145 0 0) as the panel ground, --card oklch(0.205 0 0) for the suggestion
             surface, --foreground oklch(0.985 0 0) for the body, --border oklch(1 0 0 / 10%)
             for the hairline, --muted-foreground oklch(0.708 0 0) for labels and metadata,
             --destructive oklch(0.704 0.191 22.216) for a refusal. No brand hue: that is
             still under Unresolved in DECISIONS.md and this surface is not the place to
             settle it.

Type         Inter only, one weight for labels and one for values. The suggestion body is the
             only long-form text on the surface; everything else is a label or a control.

Density      Middle, a deliberate deviation from the airy default: the panel sits inside a
             layout it does not own, and every pixel it takes is one LinkedIn wanted for its
             own content. Suggestion text 15px, control row 32px, no airy 68px rows.

Signature    The panel is unmistakably Pitchbox and never imitates LinkedIn: dark card, 1px
             hairline, its own mark, visibly a tool the human installed. See decision 1.

States       In scope: resting (present, nothing requested), streaming, ready, edited,
             inserted, and refused. Refused is five real states with five different remedies,
             not one error: quota exhausted, no LinkedIn account connected, no project bound,
             backend unreachable, selector health degraded. Streaming and refused are the two
             that decide this design; ready is the easy one.

Constraints  Shadow root, so LinkedIn's stylesheet and ours cannot reach each other. Tokens
             only, no raw hex or px (D1). Legible against both of LinkedIn's themes, which is
             a harder constraint than the repo's own dark default. Italian strings run about
             20% longer, and both dict-en.ts and dict-it.ts get the keys in one pass. uishot
             cannot reach an extension surface, so review is a human-driven Chrome window with
             the unpacked build rather than a promised screenshot.

Non-goals    Not a second inbox: one suggestion for one post, never a queue. Never suggests
             unprompted. No reactions, no DMs, no connection requests, in any form. Does not
             render on a page the human did not navigate to. Does not imitate LinkedIn's own
             interface.
```

## The three decisions, and why

**1. The panel reads as Pitchbox, not as part of LinkedIn.**

Dark card, 1px hairline, its own mark, visibly a tool the human installed. Three reasons. The compliance boundary in `docs/linkedin-integration-design.md` rests on the human always knowing whose text this is and who is acting, and a panel that imitates its host quietly undermines that. A native-looking panel would also have to chase LinkedIn's own restyles forever, on top of the selector fragility #303 already exists to contain. And the standing tooling-chrome preference is that a tool's own palette beats an imported one: the pane should read as a surface of the app, not as a window pasted on top of it.

The cost is real and stated rather than hidden: a visibly third-party dark overlay on LinkedIn is what the tools LinkedIn has restricted look like. The difference has to come from behaviour rather than appearance, which is why the panel is quiet, small, and clearly inert until asked. The two rejected options were a native light surface (rejected: imitating the host is the deceptive option) and a neutral panel that follows LinkedIn's theme while keeping Pitchbox forms (rejected as a cost that buys little: two themes to verify in AA for a surface whose whole job is to be recognisably ours).

**2. The panel is anchored to the post the human acted on, and appears nowhere else.**

The job is specific to one post, so the anchor answers "which post is this about" for free, where a single floating panel needs an explicit affordance to say the same thing. A docked rail is the wrong shape for a surface that is empty most of the time and would move attention away from the post being read.

The cost: anchoring makes more of LinkedIn's DOM load-bearing, which is more selector surface, which is more of the fragility #303 exists to contain. That is the trade accepted here, and it is the reason #303's selector-health reporting is a requirement rather than a nicety.

**3. During the wait, a skeleton shaped like a comment plus a status line saying what is happening.**

The suggestion endpoint streams, so there is no spinner, but the first token is five to ten seconds away and a mute skeleton for that long reads as stuck. So the skeleton carries one explicit status line (reading the post, writing) in the interface's own voice. That costs one string in two languages and looks slightly theatrical when the answer arrives in two seconds, which is the cheaper failure of the two.

Rejected: a mute skeleton alone (too long a silence at this latency), and streaming into an empty box with no skeleton (honest about generating now, but the layout grows while you read, which is the motion the profile's skeleton rule exists to avoid).

## Round two: the companion (approved 2026-09-07)

Status: approved 2026-09-07, epic #385. Built in #386 (overlay panel), #387 (reasoning and draft split), #388 (feed), #389 (what it knows). The rules it creates are rows D13, D14 and D15 in `docs/design/DECISIONS.md`, and D13 supersedes D11 above.

The round-one brief survives except where this section overrides it. Lorenzo installed the build, used it on a real post, and named four things. Three were design, one was product, and all four are in scope here.

```
Subject      The same panel, now the visible half of a companion rather than of a project's
             voice: it knows who the operator is, what they build, and what they have
             shipped, and it can write about anything rather than only about a bound product.

Audience     Unchanged, with one addition: the operator now reads two things in the panel
             rather than one, and the first (why this angle) has to be skimmable in about a
             second so it does not delay the second (the draft).

The job      Unchanged. Request, read, edit, insert. What changes is that the panel makes
             clear what it is offering to post and what it is only telling the operator.

Palette      Unchanged, tokens only. Reasoning uses --muted-foreground, the draft
             --foreground: the hierarchy is weight and size, not a new colour.

Type         Inter only. Reasoning 13px, draft 15-16px in the editable box. Round one said
             "the suggestion body is the only long-form text on the surface"; there are now
             two bodies, and the smaller one must lose.

Density      Middle still, but the panel no longer borrows LinkedIn's column: it is ~440px
             with a 60vh ceiling and its own scroll, so density is now a choice rather than
             a consequence of the anchor's width.

Signature    The overlay itself: a Pitchbox card floating above the feed, anchored to the
             post it is about and naming its author in the header.

States       Round one's six, plus two the split creates and one the feed creates:
             "declined" (the model chose not to write, reason shown, nothing insertable),
             "no draft" (the model ignored the shape, reason shown, nothing insertable),
             and a feed post with no URN, which is a normal success and not a degraded one.

Constraints  Round one's, plus: the panel is now in document.body, so its z-index has to beat
             LinkedIn's sticky chrome and its dismissal has to work for a floating surface
             (Escape, outside pointer-down). Reasoning must never render inside an insertable
             control. Nothing captured about the operator may reach a prompt without being
             visible and editable in /settings/companion.

Non-goals    Still not a second inbox, still never unprompted, still no DMs or reactions.
             Does not read a profile that is not the operator's own. Does not reach a private
             repository (that needs the app in #390). Does not decide what to post: a draft
             is inserted into LinkedIn's composer and the human presses LinkedIn's button.
```

**Why the panel floats now.** The anchored decision was right about the question it answered ("which post is this about") and wrong about what it cost. Anchoring was implemented as an inline sibling whose width was copied from LinkedIn's comment form, and that form is about 260px wide on a post-detail page, so the panel was unreadable in the only place it ever appeared. The header names the post's author, which answers the same question at a fraction of the layout cost, so the anchor is now a position rather than a parent. See D13.

**Why the split is server-side.** The panel could look for the model's reasoning and strip it, and that is exactly the design that produced #382: a surface built to stop a bad comment offering one, because the refusal was text like any other text. The server splits on a marker and the fail-safe is "no marker, no draft", which makes the worst case an empty draft instead of a wrong one. A model asked to emit an exact shape complies most of the time, and a design that needs it to comply every time is a design that fails intermittently in production. See D14.

**Why passive capture, and only the operator's own profile.** The companion needs to know who is writing, and rule 2 of the compliance boundary forbids Pitchbox initiating any request to or navigation of linkedin.com. So the persona is read from the operator's own profile page when they open it themselves, the voice samples from their own activity page, and the server refuses a capture whose handle does not match the persona it already holds: opening somebody else's profile must not rewrite who the assistant thinks you are.
