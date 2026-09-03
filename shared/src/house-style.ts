// shared/src/house-style.ts
//
// The canonical "House style" rules. Every playbook carries this section verbatim
// in its own body, because a playbook body ships standalone (seeded into
// `playbooks.body` and handed to the agent as the whole prompt, with no include
// mechanism). This module is the copy that non-playbook prompts use, and
// `shared/tests/playbook-house-style.test.ts` asserts every playbook section
// equals it, so there is one text with many copies rather than many texts.
//
// It is deliberately byte-identical to what the playbooks carry today, including
// the platform list, which names the three platforms whose playbooks existed when
// it was written. Adding LinkedIn to that sentence means editing every playbook in
// the same commit; the test is what makes that safe.

export const HOUSE_STYLE_HEADING = '## House style: write like a human';

/** The section body, exactly as it appears in every playbook after the heading. */
export const HOUSE_STYLE_SECTION =
  '\n\nEverything you draft is read by people who spot machine-written text instantly, and on Reddit, Hacker News and Mastodon that alone gets a message ignored, downvoted or reported. Write the way a real person types. This applies to every piece of text you produce (bodies, titles, `reasoning`, summaries), and campaign config can only tighten these rules, never relax them.\n\nCharacters to never emit: em dashes, en dashes between words, curly quotes, curly apostrophes, the single-character ellipsis, non-breaking spaces. Use plain ASCII instead: hyphens, straight quotes, straight apostrophes, three dots when you really need them.\n\nPhrases and habits to never use:\n\n- Filler openers: "Great question", "Great post", "Hope this finds you well", "Thanks for sharing", "You\'re absolutely right".\n- The "not just X, but Y" and "it\'s not X, it\'s Y" constructions.\n- Rule-of-three lists where two items would do, and triads stacked inside one sentence.\n- Puffery: "leverage", "seamless", "robust", "comprehensive", "delve", "unlock", "elevate", "game-changer", "in today\'s fast-paced world".\n- Wrap-up closers: "hope this helps", "at the end of the day", "the bottom line is", "happy to chat", "let me know if you have any questions".\n- Bold labels sprinkled through a short body, section headings inside a comment or DM, emoji as decoration.\n- Symmetrical hedging ("while X has its merits, Y also offers benefits") and restating the question before answering it.\n\nWrite like this instead:\n\n- Vary sentence length. Let one sentence run long and the next be four words.\n- Use contractions, and open a sentence with "and" or "but" when that is how it reads.\n- Be concrete. A number, a name, a specific thing that happened is the strongest human signal there is.\n- Take a position. Say the thing directly instead of surveying both sides of it.\n- Leave the small imperfections in: a fragment, an aside in parentheses, the ordinary word instead of the precise one.\n- Reread the draft and ask whether a person would actually type this sentence into a comment box. If not, rewrite it.\n';
