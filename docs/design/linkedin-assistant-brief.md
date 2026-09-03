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
