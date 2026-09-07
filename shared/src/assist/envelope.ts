// Splits a suggestion into the model's reasoning and the draft the human may
// actually insert (#382, decided 2026-09-07).
//
// The problem this exists for: the assistant used to stream one blob of text
// straight into an editable box with an Insert button under it. When the model
// judged a post not worth commenting on it explained why - correctly - and the
// panel offered that explanation as something to post. The surface meant to
// stop a bad comment was handing one over.
//
// The design constraint is that a model asked to emit an exact format gets it
// wrong some of the time, so the separation cannot rest on it complying
// (~/.config/agents/skills/moving-work-out-of-the-model). Everything here is
// therefore written so that the WORST case is no draft at all:
//
//   - the draft is whatever follows `DRAFT_MARKER`, and nothing else ever is;
//   - no marker in the response means `draft: null`, so the panel has nothing
//     to insert and says so, rather than falling back to "insert it all";
//   - `SKIP_MARKER` is the model declining, which is a state and not text;
//   - a marker that leaks into the draft body is stripped, because a marker is
//     never something the human wants to post.
//
// Pure and synchronous, so the property "reasoning can never reach the
// composer" is testable without a model, a database or a browser.

/** The line the model puts between its reasoning and the draft. */
export const DRAFT_MARKER = '---PITCHBOX-DRAFT---';
/** The line the model puts instead of a draft when it declines to write one. */
export const SKIP_MARKER = '---PITCHBOX-SKIP---';

/** Longest marker, i.e. how much trailing text a streaming split must hold
 * back before it can be sure a marker is not being cut in half. */
const MAX_MARKER_LEN = Math.max(DRAFT_MARKER.length, SKIP_MARKER.length);

export type SuggestionEnvelope = {
  /** Why the model wrote what it wrote. Shown, never insertable. */
  reasoning: string;
  /** The text the human may insert, or null when there is nothing to insert. */
  draft: string | null;
  /** True when the model explicitly declined to write a draft. */
  skipped: boolean;
};

/** Strips both markers wherever they appear, so no marker can ever be posted. */
function stripMarkers(text: string): string {
  return text.split(DRAFT_MARKER).join('').split(SKIP_MARKER).join('');
}

function clean(text: string): string {
  return stripMarkers(text).replace(/^\s+|\s+$/g, '');
}

/**
 * Splits a complete response. `draft` is non-null only when the draft marker
 * was present AND what followed it has content.
 */
export function splitSuggestion(text: string): SuggestionEnvelope {
  const skipAt = text.indexOf(SKIP_MARKER);
  const draftAt = text.indexOf(DRAFT_MARKER);

  // Whichever marker comes first is the one the model meant; a response
  // carrying both is a model that changed its mind mid-answer, and the
  // conservative read of that is the earlier decision.
  if (skipAt !== -1 && (draftAt === -1 || skipAt < draftAt)) {
    return {
      // Text after a skip marker is more of the explanation, not a draft, so
      // it stays in the reasoning where it cannot be inserted.
      reasoning: clean(text),
      draft: null,
      skipped: true,
    };
  }

  if (draftAt === -1) {
    // No structure at all. Everything is reasoning: this is the fail-safe the
    // module exists for, and it is deliberately not a heuristic guess at where
    // a draft might begin.
    return { reasoning: clean(text), draft: null, skipped: false };
  }

  const draft = clean(text.slice(draftAt + DRAFT_MARKER.length));
  return {
    reasoning: clean(text.slice(0, draftAt)),
    draft: draft.length > 0 ? draft : null,
    skipped: false,
  };
}

/** One incremental piece of a split stream. Either side may be empty. */
export type EnvelopeChunk = {
  /** Newly available reasoning text. */
  reasoning: string;
  /** Newly available draft text. */
  draft: string;
  /** True once the draft marker has been seen. */
  inDraft: boolean;
  /** True once the skip marker has been seen. */
  skipped: boolean;
};

/**
 * Streaming counterpart of `splitSuggestion`, so the panel can show reasoning
 * as it arrives and then the draft, instead of waiting for the whole response.
 *
 * The only subtlety is that a marker can be cut in half between two chunks, so
 * up to `MAX_MARKER_LEN - 1` characters are held back until either a marker
 * completes or enough text arrives to rule one out. `finish()` releases the
 * held-back tail and returns the same envelope `splitSuggestion` would.
 */
export class EnvelopeSplitter {
  private pending = '';
  private reasoning = '';
  private draft = '';
  private inDraft = false;
  private didSkip = false;

  push(chunk: string): EnvelopeChunk {
    this.pending += chunk;
    let outReasoning = '';
    let outDraft = '';

    // Loop rather than one pass: a single chunk can carry the marker plus the
    // start of the draft, and both halves have to be routed in this call.
    for (;;) {
      if (this.didSkip) {
        // Everything after a skip is explanation. Route it to reasoning.
        outReasoning += this.pending;
        this.reasoning += this.pending;
        this.pending = '';
        break;
      }

      if (!this.inDraft) {
        const skipAt = this.pending.indexOf(SKIP_MARKER);
        const draftAt = this.pending.indexOf(DRAFT_MARKER);
        if (skipAt !== -1 && (draftAt === -1 || skipAt < draftAt)) {
          const before = this.pending.slice(0, skipAt);
          outReasoning += before;
          this.reasoning += before;
          this.pending = this.pending.slice(skipAt + SKIP_MARKER.length);
          this.didSkip = true;
          continue;
        }
        if (draftAt !== -1) {
          const before = this.pending.slice(0, draftAt);
          outReasoning += before;
          this.reasoning += before;
          this.pending = this.pending.slice(draftAt + DRAFT_MARKER.length);
          this.inDraft = true;
          continue;
        }
        // No complete marker yet: release everything except a tail that could
        // still turn into one.
        const safe = Math.max(0, this.pending.length - (MAX_MARKER_LEN - 1));
        if (safe > 0) {
          const text = this.pending.slice(0, safe);
          outReasoning += text;
          this.reasoning += text;
          this.pending = this.pending.slice(safe);
        }
        break;
      }

      // Inside the draft. A stray marker here is stripped rather than routed,
      // so it can never be inserted, and the same hold-back applies.
      const safe = Math.max(0, this.pending.length - (MAX_MARKER_LEN - 1));
      if (safe > 0) {
        const text = stripMarkers(this.pending.slice(0, safe));
        outDraft += text;
        this.draft += text;
        this.pending = this.pending.slice(safe);
      }
      break;
    }

    return {
      reasoning: outReasoning,
      draft: outDraft,
      inDraft: this.inDraft,
      skipped: this.didSkip,
    };
  }

  /** Flushes the held-back tail and returns the final envelope. */
  finish(): SuggestionEnvelope {
    if (this.pending.length > 0) {
      // The tail can still complete a marker, so it goes back through the
      // whole-response splitter rather than being appended blindly.
      const rest = this.pending;
      this.pending = '';
      if (this.didSkip) {
        this.reasoning += rest;
      } else if (this.inDraft) {
        this.draft += stripMarkers(rest);
      } else {
        const tail = splitSuggestion(rest);
        this.reasoning += tail.reasoning;
        if (tail.skipped) this.didSkip = true;
        if (tail.draft) {
          this.inDraft = true;
          this.draft += tail.draft;
        }
      }
    }

    const reasoning = clean(this.reasoning);
    if (this.didSkip) return { reasoning, draft: null, skipped: true };
    const draft = clean(this.draft);
    return {
      reasoning,
      draft: this.inDraft && draft.length > 0 ? draft : null,
      skipped: false,
    };
  }
}

/**
 * The instruction block that asks for this shape. Lives next to the parser so
 * the two cannot drift: a change to either marker changes the prompt in the
 * same edit.
 */
export function envelopeInstruction(): string {
  return [
    'Answer in two parts, in this exact shape:',
    '',
    'First, at most three sentences on what you noticed in the post and the angle you picked. Write it for the operator, not for the reader of the comment.',
    '',
    `Then, alone on its own line, ${DRAFT_MARKER}`,
    '',
    'Then the text to post, and nothing else: no preamble, no quotes around it, no alternatives to choose from, no notes after it.',
    '',
    `If the post is not worth writing anything for, put ${SKIP_MARKER} alone on its own line instead of the draft, and say why in one sentence. Do not write a draft you do not believe in.`,
  ].join('\n');
}
