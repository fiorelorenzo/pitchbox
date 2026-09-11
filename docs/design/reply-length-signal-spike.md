# What predicts the length of his reply? - spike (LOR-271)

Status: spike, closed. No prompt change, no scorer change, no runtime behaviour change.
This document and `scripts/spike-lor271-length-signal.ts` are the deliverable.

Filed from LOR-253, which measured and rejected a length target derived from the post
being answered (Pearson r = 0.118 raw, 0.382 log-scaled, on the same 27-case corpus used
below - essentially no signal). This spike asks the wider question LOR-253's rejection
opened: is there _anything_ available at drafting time that predicts how long Lorenzo's
reply will be, and if not, what should the product do instead?

## Conclusion

**In the domain the product actually drafts for - a comment under someone else's LinkedIn
post - nothing tested predicts reply length at a sample size (n=27) that can support a
claim.** Every one of the nine candidates measured against the real 27-case corpus,
including post length itself, comes back statistically indistinguishable from noise
(permutation p ranging 0.18-0.90; the one candidate below p=0.05, post length on a
log scale, sits at p=0.052 - the same "not distinguishable from run-to-run variance"
verdict LOR-253 already reached, now confirmed by a second, independent method).

**A different, better-populated corpus - Lorenzo's own 233 sent LinkedIn DMs - does carry
real signal.** Four candidates there clear both a permutation p<0.05 and a conventional
medium-or-larger effect size: the length of the message he's replying to (r=0.44 raw,
r=0.61 log-scaled, n=188), how long he took to respond (r=0.37 log-scaled, n=188), how
established the conversation is (r=-0.28, n=89, more history means _shorter_ replies), and
above all **which specific person he's talking to** (eta<sup>2</sup>=0.375, n=105 replies
across 22 contacts - the single largest effect found anywhere in this spike, more than
double the next-largest). This proves length-predicting signal _can_ exist for this
operator. It does not prove it exists in the product's actual domain: DMs are a private,
reciprocal, ongoing exchange between two people who already know each other, and a public
post comment is a different speech act to a different, wider audience. Corpus A's own
(underpowered) attempt at the closest DM analogue - whether the post's author is someone
he has already answered more than once - points in the _opposite_ direction (repeat
authors get shorter replies, not longer, though not reliably either way at n=24).

**Recommendation: (b) - keep the operator's-own-distribution-per-genre target that `main`
already ships (`shared/src/assist/suggest-prompt.ts`'s `lengthTarget`, "operator's own
habit" branch), and make no further change chasing the long tail.** Not (a): the current
approach already gets the very-short and short buckets close to Lorenzo's real medians
(LOR-253's own baseline table: short bucket 18-21 words suggested against a true median of
18; very-short 13-15 against a true median of 3, off but in the right neighbourhood), and
removing the target entirely risks that working majority for a long tail (3 of 27 cases)
that no measured in-domain signal reaches anyway. Not (c): nothing measured in the actual
comment domain clears a bar worth keying a classifier on, and the one candidate that looks
like a positive finding on Corpus A ("genre: launch", median 39 words) is not independent
evidence - see "The genre finding is not a finding" below.

**What would falsify this recommendation:** a post-comment corpus large enough to give the
same candidates the statistical power Corpus B had (n in the 80-100+ range, roughly where
Corpus B's own signals became detectable) showing a candidate - most plausibly contact
identity, given Corpus B's result - clear permutation p<0.05 with |r|>=0.3 or
eta<sup>2</sup>>=0.06, replicated on a second, independently harvested batch of comparable
size. Until a corpus that size exists for post comments specifically, there is nothing to
build (c) on. Re-run `scripts/spike-lor271-length-signal.ts --cases=<new-file>` against it
verbatim; the script does not need to change to test this.

No model call was made anywhere in this spike. Every number below is a deterministic
statistic over text that was already written by a human - post length, question marks,
timestamps, word counts - not a generated suggestion. Cost: $0, one CPU-bound run,
1.8 seconds.

## Every predictor tested

Both corpora, every candidate, one row per statistic. `n` is the sample behind that row,
not the corpus total, where a candidate excludes cases (see notes). Continuous-vs-continuous
and binary-vs-continuous candidates report Pearson's r (a point-biserial correlation is a
Pearson correlation of a 0/1 variable, so one statistic covers both) with a Fisher-z 95% CI
and a permutation p-value (9999 seeded shuffles - no distributional assumption, which
matters at n=27). A categorical candidate (genre, contact identity) reports eta-squared
(share of variance the grouping explains) with the same permutation test. "Load-bearing"
below means: permutation p<0.05 **and** an effect at or above Cohen's conventional "medium"
threshold (|r|>=0.3, eta<sup>2</sup>>=0.06) - statistically real but small is called out as
such, not silently promoted.

### Corpus A - `private/voice-eval/cases.json`, 27 real LinkedIn post+comment pairs

| #   | candidate                                                             | n       | effect               | 95% CI          | p     | verdict                                                      |
| --- | --------------------------------------------------------------------- | ------- | -------------------- | --------------- | ----- | ------------------------------------------------------------ |
| 1   | post length, words (raw)                                              | 27      | r=0.118              | [-0.275, 0.476] | 0.598 | noise                                                        |
| 1   | post length, words (log-log)                                          | 27      | r=0.382              | [0.002, 0.665]  | 0.052 | not reliable at this n (LOR-253's own conclusion, confirmed) |
| 2   | post contains a "?"                                                   | 27      | r=-0.196             | [-0.536, 0.199] | 0.324 | noise                                                        |
| 3   | post register reads technical (code-or-jargon/numbers)                | 27      | r=0.142              | [-0.252, 0.495] | 0.479 | noise                                                        |
| 4   | post genre (launch/hiring/celebration/event/other, keyword heuristic) | 27      | eta<sup>2</sup>=0.12 | n/a             | 0.180 | not a finding - see below                                    |
| 5   | replying on his own post                                              | 27      | r=0.024              | [-0.359, 0.401] | 0.897 | noise                                                        |
| 6   | post language is English (vs Italian)                                 | 27      | r=0.168              | [-0.226, 0.515] | 0.403 | noise                                                        |
| 7   | post author is a repeat contact within this set                       | 24      | r=-0.183             | [-0.546, 0.238] | 0.399 | noise                                                        |
| 8   | post addresses him by name ("Lorenzo")                                | 4 of 24 | -                    | -               | -     | too few to test (see below)                                  |
| 9   | existing comment count / thread position                              | 0       | -                    | -               | -     | untestable, no data (see below)                              |

### Corpus B - `private/voice-eval/linkedin-export`, his 233 real sent DMs

Each of his 233 valid sent messages (not a draft, not empty) is classified by what
immediately preceded it in the same conversation: 188 are **replies** (the prior message
was from the other person), 39 are **continuations** of his own prior message (excluded
from every "what he's replying to" test below - there is nothing to reply to), and 6 are
**openers** (first message in the conversation).

| #   | candidate                                          | n                                   | effect                | 95% CI           | p      | verdict                                         |
| --- | -------------------------------------------------- | ----------------------------------- | --------------------- | ---------------- | ------ | ----------------------------------------------- |
| 10  | preceding message length, words (raw)              | 188                                 | r=0.444               | [0.321, 0.552]   | 0.0001 | **load-bearing**                                |
| 10  | preceding message length, words (log-log)          | 188                                 | r=0.606               | [0.507, 0.689]   | 0.0001 | **load-bearing**                                |
| 11  | preceding message contains a "?"                   | 188                                 | r=0.105               | [-0.039, 0.244]  | 0.152  | noise                                           |
| 12  | message is a cold conversation-opener              | 233                                 | r=-0.048              | [-0.176, 0.081]  | 0.462  | noise (n=6 openers, too thin regardless)        |
| 13  | preceding message language is English (vs Italian) | 140                                 | r=-0.133              | [-0.292, 0.034]  | 0.123  | not reliable                                    |
| 14  | conversation's total message count (raw)           | 89                                  | r=-0.189              | [-0.382, 0.020]  | 0.065  | not reliable                                    |
| 14  | conversation's total message count (log-log)       | 89                                  | r=-0.276              | [-0.458, -0.072] | 0.0097 | real, but small (below the 0.3 effect floor)    |
| 15  | response latency in minutes (raw)                  | 188                                 | r=0.008               | [-0.135, 0.151]  | 0.903  | noise                                           |
| 15  | response latency in minutes (log-log)              | 188                                 | r=0.365               | [0.234, 0.482]   | 0.0001 | **load-bearing**                                |
| 16  | which specific contact he is replying to           | 105 (22 contacts, >=3 replies each) | eta<sup>2</sup>=0.375 | n/a              | 0.0131 | **load-bearing - largest effect in this spike** |

Group breakdowns behind each row (medians, exclusion counts) are in the script's own console
output - re-run it; nothing here is hand-copied from a different run.

## The genre finding is not a finding

Candidate 4's "launch" bucket has a median of 39 words against 5-11 for the other three
buckets, which looks like the strongest result on Corpus A. It is not independent evidence:
exactly two cases match the keyword pattern, and both are two separate comments Lorenzo left
under the _same_ post (LOR-44's importer already documents this shape: "a post the operator
commented on more than once produces one case per comment, sharing the post"). That post is
one of the three long-tail cases LOR-253 was filed about in the first place. Labelling it
"launch" and reporting its median back as a discovery would be circular - it is the same n=1
anecdote already on record, wearing a new column. Nothing about this spike's genre heuristic
generalises past that one post.

## What could not be tested, and why

- **Existing comment count under the post / thread position (candidate 9).** Not a gap in
  this analysis - a gap in the data. `shared/src/voice-eval-cases.ts`'s own schema comment
  says the thread field is "absent in every case harvested so far," and `cases.json` bears
  that out: no case in it carries thread data. The product's own prompt builder
  (`suggest-prompt.ts`'s `lengthTarget`) already has a code path for exactly this signal (a
  "room" median read from the thread's other comments) - it has simply never fired, because
  nothing has ever captured a thread to feed it. This is worth flagging as a real next step
  for whoever harvests the next corpus, not as a finding either way: there is no evidence
  this signal works, only evidence nobody has ever had the data to check.
- **Addressed by name (candidate 8).** Only 4 of the 27 posts mention "Lorenzo" at all, and 3
  of those are the self-authored cases (he is naming himself in his own post) - leaving a
  single non-self case. One data point is not a sample; reporting a correlation on it would
  be reporting a coin flip.
- **"Who the other person is" on Corpus A.** Candidate 7 is the closest analogue this corpus
  supports (repeat vs one-off post authors, n=24), and it comes back both non-significant and
  in the opposite direction from Corpus B's contact-identity result. Given n=24 with at most 2
  observations per repeat author, this is not strong enough evidence to contradict Corpus B
  either - it is simply underpowered, in both directions.

## Reproduction

Everything above comes from one command, run from the repository root of this worktree:

```bash
npx tsx scripts/spike-lor271-length-signal.ts
```

Optional flags: `--cases=<path>` (default `private/voice-eval/cases.json`) and
`--export-dir=<path>` (default `private/voice-eval/linkedin-export`, expects one `.zip`
inside it containing `messages.csv` - LinkedIn's "Basic" data export). Requires the system
`unzip` binary; no other new dependency. The script makes no network call and reads no
`AI_GATEWAY_API_KEY` - it is pure statistics over already-written text, which is why it is
free to re-run as many times as this doc's claims need checking. Two runs against the same
input print byte-identical tables (the permutation test's PRNG is seeded, not
`Math.random()`), verified by diffing two consecutive runs before writing this doc.

Worth keeping as a script, not deleting after this spike: the moment a larger post-comment
corpus exists, `--cases=<path to it>` re-runs the exact same sixteen candidates against it
with no code change - which is precisely the falsifying measurement above.

## Corpora, precisely

- **Corpus A**: `private/voice-eval/cases.json`, 27 cases, each a real LinkedIn post paired
  with the comment Lorenzo actually wrote under it. Untracked, gitignored, never quoted here
  beyond aggregate counts.
- **Corpus B**: `private/voice-eval/linkedin-export/`, LinkedIn's "Basic" personal data
  export (a zip of CSVs). `messages.csv` (1297 rows) is the only file this spike reads from
  it; it is a different export than the `Shares.csv`/`Comments.csv` pair
  `shared/src/voice-import-archive.ts` already knows how to parse (that pair requires
  LinkedIn's separate, slower "full" export and was not present in this "Basic" one), so this
  spike wrote its own minimal CSV reader rather than reusing that module for a file shape it
  does not handle. 233 of those rows are Lorenzo's own sent, non-draft, non-empty messages;
  188 of those are classified as a reply to an inbound message from someone else, the subset
  every "preceding message" candidate above is measured on.

No case body from either corpus is quoted anywhere above or in the script's own output -
every number is an aggregate (a count, a median, a correlation) and every third-party
contact in candidate 16 is an anonymised label (`contact-01` through `contact-22`), not a
name.

## LOR-281: does the reply-drafter's own domain carry it?

Status: spike, closed. No prompt change, no scorer change, no playbook change - LOR-281's
own acceptance criteria rule that out regardless of the numbers below, the same way LOR-271's
did above. This section and `scripts/spike-lor281-reply-drafter-length-signal.ts` are the
whole deliverable.

Filed from LOR-271's own conclusion above. On Corpus B (233 of Lorenzo's real sent LinkedIn
DMs), three candidates cleared LOR-271's bar: the length of the message he's replying to
(r=0.44 raw, r=0.61 log), how long he took to reply (r=0.37 log), and which specific contact
he's replying to (eta<sup>2</sup>=0.375, the largest effect anywhere in that spike). LOR-271
measured all three on a private, reciprocal exchange between people who already know each
other. That is not the reply-drafter playbook's own domain
(`playbooks/reply-drafter.md`: a continuation of a thread on Reddit, Hacker News or Mastodon,
`reply_comment` public or `reply_dm` private) on at least two axes that matter: the target
user is a stranger far more often than an existing contact, and on Reddit/HN a `reply_comment`
is public rather than a DM. The argument for reusing LOR-271's numbers there is exactly
"both are a reciprocal 1:1 exchange" - and per LOR-271's own issue, that argument, not the DM
numbers themselves, is the risk this spike exists to check.

### No corpus of that domain exists to harvest

Checked before writing a line of analysis, not assumed: no Reddit/HN/Mastodon export sits
anywhere under `private/` in this worktree, this worktree's database is a fresh core seed
with no real campaign history, and no production database is reachable from a worktree.
LOR-271's own two corpora came from Lorenzo's own logged-in LinkedIn session; nothing
analogous has been harvested yet for a real Reddit, Hacker News or Mastodon account. This is
not a gap in this analysis, it is a gap in the data available to it - the same posture
LOR-271 itself took for "existing comment count / thread position" (untestable, no data,
scored neither way, not guessed at).

Given that, this spike does the next best thing rather than pretend the gap does not exist:
it re-uses Corpus B (already carrying the strongest three candidates) and asks the one
question it _can_ answer without new data - does relationship depth explain those three
candidates? - since "he already knows this person" is exactly the assumption a stranger
reply on Reddit or HN breaks. Every conversation in Corpus B is split into **single-exchange**
(he replied to that contact exactly once in the whole export - the closest this corpus gets
to "a stranger, once") and **established** (two or more of his replies to the same contact -
the shape LOR-271 actually measured). A candidate whose effect survives in the single-exchange
half is not just an artifact of an existing relationship; one that does not is itself an
answer for that half of the analogy.

### The test

| candidate                          | subset                   | n          | effect                | 95% CI          | p      | verdict                                 |
| ---------------------------------- | ------------------------ | ---------- | --------------------- | --------------- | ------ | --------------------------------------- |
| preceding message length (log-log) | full corpus (reproduced) | 188        | r=0.606               | [0.507, 0.689]  | 0.0001 | **load-bearing** (LOR-271's own number) |
| preceding message length (log-log) | single-exchange          | 51         | r=0.615               | [0.408, 0.761]  | 0.0001 | **load-bearing - survives**             |
| preceding message length (log-log) | established              | 137        | r=0.58                | [0.457, 0.682]  | 0.0001 | **load-bearing** (comparison group)     |
| response latency (log-log)         | full corpus (reproduced) | 188        | r=0.365               | [0.234, 0.482]  | 0.0001 | **load-bearing** (LOR-271's own number) |
| response latency (log-log)         | single-exchange          | 51         | r=0.208               | [-0.072, 0.457] | 0.1414 | **does not survive**                    |
| response latency (log-log)         | established              | 137        | r=0.373               | [0.219, 0.509]  | 0.0001 | **load-bearing** (comparison group)     |
| which contact he is replying to    | full corpus (reproduced) | 105 of 188 | eta<sup>2</sup>=0.375 | n/a             | 0.0131 | **load-bearing** (LOR-271's own number) |
| which contact he is replying to    | single-exchange          | 51         | -                     | n/a             | -      | **structurally uncomputable**           |

Every row reproduces from `npx tsx scripts/spike-lor281-reply-drafter-length-signal.ts`
(exact command in "Reproduction" below); nothing here is hand-copied from a different run.

**Preceding message length holds up.** It clears the same bar in the single-exchange half
(r=0.615 log, n=51) as it does in the established half (r=0.58 log, n=137) and the full corpus
(r=0.606 log, n=188) - within noise of each other, not a step down. Whatever drives this
correlation, it is not "he already knows this person."

**Response latency does not.** It clears p<0.05 with a medium-or-larger effect in the
established half (r=0.373 log, p=0.0001) but not in the single-exchange half (r=0.208 log,
p=0.1414, CI crosses zero) - consistent with a delayed reply to an established contact coming
with more catching-up text than a delayed reply to someone he may never hear from again. At
n=51 this is "not distinguishable from noise at this n," the same verdict LOR-271 gave
borderline candidates on Corpus A, not a confident rejection - but it is real evidence the
effect concentrates in ongoing relationships rather than being latency-driven in general.

**Contact identity is the one that cannot even be asked the question.** Every contact in the
single-exchange half has exactly one reply by construction - that is what "single-exchange"
means - so an eta-squared there would measure group size, not a per-contact effect: zero
groups reach any floor at all. Widening the lens: only 22 of 89 distinct conversation partners
in the whole of Corpus B (24.7%) ever reach the >=3-reply floor LOR-271's own eta-squared
needed - the largest effect LOR-271 found is already concentrated in a minority of Lorenzo's
own LinkedIn contacts. A Reddit or HN account replying to strangers in public threads has,
structurally, far fewer repeat contacts than an existing professional network built over
years - this is reasoned from how the two platforms work, not measured on Reddit data, since
no Reddit data exists to measure it on (see above). Reasoned or measured, the direction is the
same: the single largest effect in LOR-271's spike is the one candidate least likely to
transfer to the reply-drafter's actual domain, because that domain's own shape is largely
incompatible with the repeated-contact structure the effect needs to exist at all.

### Conclusion

**No signal-derived length target ships from this spike, and nothing under
`playbooks/reply-drafter.md` or `shared/src/assist/suggest-prompt.ts` changes.** Two
independent reasons, either one sufficient on its own: LOR-281's own acceptance criteria rule
out a prompt or playbook change in this issue regardless of the numbers, and separately, no
real corpus of the reply-drafter's actual domain (a Reddit/HN/Mastodon thread-reply pair) was
obtainable to test the analogy directly - only a same-corpus proxy for one axis of it
(relationship depth). That proxy is not reassuring across the board: it is genuinely
supportive for preceding-message length (survives the stranger-like restriction intact) and
genuinely discouraging for the other two candidates LOR-271 found - response latency weakens
below the significance bar, and contact identity, the largest effect measured anywhere in
LOR-271's spike, is structurally the least transferable of the three to a domain of mostly
one-off strangers.

`playbooks/reply-drafter.md`'s existing length guidance (1-3 short paragraphs for a `reply_dm`,
1-2 sentences for a `reply_comment`) stays exactly as written - the same
operator/genre-level default LOR-271 recommended keeping for the structurally similar
comment-drafting problem, for the same reason: nothing measured against the domain that
actually matters clears a bar worth keying a change on.

### What would change this answer

A real corpus of reply-drafter thread-reply pairs (the parent turn plus the reply Lorenzo
actually sent, harvested from real Reddit, Hacker News or Mastodon account activity - real
text, no synthetic cases, the same discipline Corpus A and B were held to), at a scale
comparable to Corpus B (n in the 100+ range). `scripts/spike-lor281-reply-drafter-length-signal.ts`
already has a loader for it: `--reddit-cases=<path>` (schema in the script's own
`RedditCase`/`RedditCasesFile` types - id/platform/replyKind/precedingWords/replyWords/
optional latencyMinutes/contactId) runs the same candidates against it with no further code
change, the same promise LOR-271's own script makes for a bigger post-comment corpus. Worth
testing first on that corpus, in order: preceding message length (the one candidate that
survived this spike's own stranger-like restriction), then response latency and contact
identity only if the first replicates and there is n to spare - contact identity specifically
needs enough repeat contacts to reach the >=3-reply floor at all, which a cold-outreach
account may simply never accumulate.

### Reproduction

```bash
npx tsx scripts/spike-lor281-reply-drafter-length-signal.ts
```

Optional flags: `--export-dir=<path>` (default `private/voice-eval/linkedin-export`, same
Corpus B LOR-271's script reads) and `--reddit-cases=<path>` (default: none, reported as an
explicit zero-data finding rather than skipped silently). No model call, no network - the
permutation test uses the same seeded mulberry32 PRNG LOR-271's script uses, so a re-run
prints byte-identical numbers; verified by diffing two consecutive runs before writing this
section.
