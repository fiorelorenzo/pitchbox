// Splits a suggestion into the project it is actually about, the model's
// reasoning, and the draft the human may actually insert (#382, decided
// 2026-09-07; the project field joined it for LOR-181, 2026-09-10).
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
// therefore written so that the WORST case is no draft at all, and - since
// LOR-181 - no project claim at all either:
//
//   - the draft is whatever follows `DRAFT_MARKER`, and nothing else ever is;
//   - no marker in the response means `draft: null`, so the panel has nothing
//     to insert and says so, rather than falling back to "insert it all";
//   - `SKIP_MARKER` is the model declining, which is a state and not text;
//   - a marker that leaked into the draft body is stripped, because a marker is
//     never something the human wants to post;
//   - `PROJECT_MARKER`, when present, is the very first thing in the response -
//     ahead of the reasoning, so a wrong or missing project never delays or
//     corrupts what the panel shows. `projectChoice` is the model's raw,
//     unvalidated claim (a bare id or the literal `personal`) - this module
//     knows nothing about which projects exist, so it never resolves the claim
//     against anything real. `web/src/lib/server/suggest.ts` does that: an id
//     that is not one of the organization's own projects falls back to
//     personal and is logged, exactly like a missing marker falls back to no
//     draft rather than guessing one.
//
// Pure and synchronous, so the property "reasoning can never reach the
// composer" is testable without a model, a database or a browser.

/** The line the model puts, alone on the very first line of its reply,
 * ahead of everything else - see `extractProjectChoice` for the shape that
 * follows it. */
export const PROJECT_MARKER = '---PITCHBOX-PROJECT---';
/** The line the model puts between its reasoning and the draft. */
export const DRAFT_MARKER = '---PITCHBOX-DRAFT---';
/** The line the model puts instead of a draft when it declines to write one. */
export const SKIP_MARKER = '---PITCHBOX-SKIP---';

/** Longest marker, i.e. how much trailing text a streaming split must hold
 * back before it can be sure a marker is not being cut in half. */
const MAX_MARKER_LEN = Math.max(DRAFT_MARKER.length, SKIP_MARKER.length);

/** Longest a stated project value (a bare id, or `personal`) is ever allowed
 * to be before parsing gives up on it - generous for either, and short
 * enough that a model that never emits the closing newline cannot hold back
 * an unbounded amount of text from the panel. */
const MAX_PROJECT_VALUE_LEN = 40;

export type SuggestionEnvelope = {
  /** Why the model wrote what it wrote. Shown, never insertable. */
  reasoning: string;
  /** The text the human may insert, or null when there is nothing to insert. */
  draft: string | null;
  /** True when the model explicitly declined to write a draft. */
  skipped: boolean;
  /** The model's raw, unvalidated claim about which project this suggestion
   * is about - a bare project id, the literal `personal`, or null when
   * `PROJECT_MARKER` never appeared at the very start of the response, or
   * nothing usable followed it. Never resolved against real data here -
   * see the module header. */
  projectChoice: string | null;
};

/** Strips both markers wherever they appear, so no marker can ever be posted. */
function stripMarkers(text: string): string {
  return text.split(DRAFT_MARKER).join('').split(SKIP_MARKER).join('');
}

function clean(text: string): string {
  return stripMarkers(text).replace(/^\s+|\s+$/g, '');
}

/**
 * Reads a project claim off the very start of `text`, if one is there -
 * `PROJECT_MARKER` alone, immediately followed by a newline and the claimed
 * value on the next line. Anything else (no marker, an empty or overlong
 * value) is `projectChoice: null` - the module's own worst-case-safe
 * posture applied to this field too. `rest` is `text` with the marker and
 * its value line removed, ready for the ordinary reasoning/draft split.
 */
function extractProjectChoice(text: string): { projectChoice: string | null; rest: string } {
  if (!text.startsWith(PROJECT_MARKER)) return { projectChoice: null, rest: text };
  // The marker is alone on its own line, so the first newline after it (if
  // any) closes the marker's line rather than the value's - skip past it
  // before looking for the newline that actually ends the value.
  let after = text.slice(PROJECT_MARKER.length);
  if (after.startsWith('\n')) after = after.slice(1);
  const nl = after.indexOf('\n');
  const valueSource = nl === -1 ? after : after.slice(0, nl);
  const rest = nl === -1 ? '' : after.slice(nl + 1);
  const value = valueSource.trim();
  return { projectChoice: value && value.length <= MAX_PROJECT_VALUE_LEN ? value : null, rest };
}

/**
 * Splits a complete response. `draft` is non-null only when the draft marker
 * was present AND what followed it has content.
 */
export function splitSuggestion(text: string): SuggestionEnvelope {
  const { projectChoice, rest } = extractProjectChoice(text);
  const skipAt = rest.indexOf(SKIP_MARKER);
  const draftAt = rest.indexOf(DRAFT_MARKER);

  // Whichever marker comes first is the one the model meant; a response
  // carrying both is a model that changed its mind mid-answer, and the
  // conservative read of that is the earlier decision.
  if (skipAt !== -1 && (draftAt === -1 || skipAt < draftAt)) {
    return {
      // Text after a skip marker is more of the explanation, not a draft, so
      // it stays in the reasoning where it cannot be inserted.
      reasoning: clean(rest),
      draft: null,
      skipped: true,
      projectChoice,
    };
  }

  if (draftAt === -1) {
    // No structure at all. Everything is reasoning: this is the fail-safe the
    // module exists for, and it is deliberately not a heuristic guess at where
    // a draft might begin.
    return { reasoning: clean(rest), draft: null, skipped: false, projectChoice };
  }

  const draft = clean(rest.slice(draftAt + DRAFT_MARKER.length));
  return {
    reasoning: clean(rest.slice(0, draftAt)),
    draft: draft.length > 0 ? draft : null,
    skipped: false,
    projectChoice,
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
  private projectResolved = false;
  private projectChoice: string | null = null;

  /**
   * Consumes a leading `PROJECT_MARKER` and its value line from `pending`,
   * once the bytes seen so far can already decide one way or the other -
   * mirrors `extractProjectChoice` but incrementally, since the whole point
   * is to never hold back more than `PROJECT_MARKER.length - 1` characters
   * from a response that is not using the field at all. Returns `true` once
   * resolved (the caller's loop should `continue`), `false` when there is
   * not yet enough to tell (the caller's loop should `break` and wait for
   * more input).
   */
  private resolveProjectPrefix(): boolean {
    if (this.pending.length < PROJECT_MARKER.length) {
      if (PROJECT_MARKER.startsWith(this.pending)) return false;
      this.projectResolved = true;
      return true;
    }
    if (!this.pending.startsWith(PROJECT_MARKER)) {
      this.projectResolved = true;
      return true;
    }
    let after = this.pending.slice(PROJECT_MARKER.length);
    // The marker is alone on its own line, so its first character - once it
    // has arrived - is the newline that closes the marker's own line, not
    // the value's. Not yet arrived is not yet resolvable either way.
    if (after.length === 0) return false;
    if (after[0] === '\n') after = after.slice(1);
    const nl = after.indexOf('\n');
    if (nl === -1) {
      // No closing newline yet - keep waiting, unless the value has already
      // run well past anything a real id or `personal` could be.
      if (after.length <= MAX_PROJECT_VALUE_LEN) return false;
      this.projectChoice = null;
      this.pending = '';
      this.projectResolved = true;
      return true;
    }
    const value = after.slice(0, nl).trim();
    this.projectChoice = value && value.length <= MAX_PROJECT_VALUE_LEN ? value : null;
    this.pending = after.slice(nl + 1);
    this.projectResolved = true;
    return true;
  }

  push(chunk: string): EnvelopeChunk {
    this.pending += chunk;
    let outReasoning = '';
    let outDraft = '';

    // Loop rather than one pass: a single chunk can carry the marker plus the
    // start of the draft, and both halves have to be routed in this call.
    for (;;) {
      if (!this.projectResolved) {
        if (!this.resolveProjectPrefix()) break;
        continue;
      }
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
    if (!this.projectResolved) {
      // A response short enough that `push()` never saw `PROJECT_MARKER.length`
      // bytes at once (or was never called at all) still gets a real answer
      // here, the same way `splitSuggestion` would give one to the whole text.
      const { projectChoice, rest } = extractProjectChoice(this.pending);
      this.projectChoice = projectChoice;
      this.pending = rest;
      this.projectResolved = true;
    }

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
        // Already past the project prefix above, so this only ever splits
        // reasoning from a draft/skip marker - `tail.projectChoice` is
        // never anything but the `null` a mid-reasoning tail resolves to.
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
    const projectChoice = this.projectChoice;
    if (this.didSkip) return { reasoning, draft: null, skipped: true, projectChoice };
    const draft = clean(this.draft);
    return {
      reasoning,
      draft: this.inDraft && draft.length > 0 ? draft : null,
      skipped: false,
      projectChoice,
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
    'Answer in this exact shape.',
    '',
    `First, alone on the very first line of your reply, ${PROJECT_MARKER}`,
    '',
    "Then, alone on the next line, the id of the project this suggestion is actually about - copy it exactly from the list above, digits only - or the word personal if none of them are what this is about and you are writing in the operator's own voice instead. Pick exactly one, even when more than one could arguably apply: the project the post is actually about.",
    '',
    'Then, at most three sentences on what you noticed in the post and the angle you picked. Write it for the operator, not for the reader of the comment, and write it in the language the operator writes in - the same language as your draft below.',
    '',
    `Then, alone on its own line, ${DRAFT_MARKER}`,
    '',
    'Then the text to post, and nothing else: no preamble, no quotes around it, no alternatives to choose from, no notes after it.',
    '',
    `If the post is not worth writing anything for, put ${SKIP_MARKER} alone on its own line instead of the draft, and say why in one sentence. Do not write a draft you do not believe in.`,
  ].join('\n');
}
