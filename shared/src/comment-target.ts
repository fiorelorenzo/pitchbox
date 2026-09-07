/**
 * Who a public comment is addressed to (issue #336).
 *
 * A `post_comment` draft used to carry `targetUser: null`, so marking it as
 * sent wrote no `contact_history` row: the Inbox dialog promised one, the
 * dedup window never saw the author, and a run could reply to the same person
 * twice with nothing to notice it. The answer is that commenting on someone's
 * post *is* contact with that person, which is already how the rest of the
 * system reasons: `reddit:scout` drops candidates whose author is in
 * `contact_history`, the LinkedIn drain (`cli/src/commands/linkedin.ts`) skips
 * an observation whose author is inside the dedup window, and the LinkedIn
 * assist accept path (`shared/src/assist-accept.ts`) already sets the post
 * author as `targetUser` on a `post_comment`.
 *
 * Copying the author's handle from the candidate into the draft is mechanical
 * work with one correct answer, which is exactly the kind of step a model
 * drops intermittently, so the code does it instead of the prompt: the run's
 * own staged candidates are the source, matched to the draft by the post
 * identifier the draft already carries. The playbooks still name the author,
 * and this makes the value correct by construction when they don't.
 *
 * Hacker News is the one platform with nothing to match against: it has no
 * scout and stages no candidates (`cli/src/commands/hn.ts` only searches, and
 * the playbook drafts straight from the tool result), so there its playbook
 * remains the only source and a missing author stays null.
 */

/** Where a platform keeps the author and the post identity, in the two shapes
 * that have to meet: `staging_scout_candidates.raw` on one side, a draft's
 * `sourceRef`/`metadata` on the other. Dotted paths into `raw`; plain keys on
 * the draft side, looked up in `sourceRef` first and then `metadata`. */
export interface CommentTargetSpec {
  /** Path to the author's stable handle. A display name is not a handle: it
   * cannot be blocklisted, deduped or matched against an incoming reply, so a
   * platform whose candidate carries only a name has no author here. */
  authorPath: string;
  /** Paths to values that identify the post the candidate is about. */
  candidateIdPaths: string[];
  /** Keys under which a draft names that same post. */
  draftIdKeys: string[];
}

export const COMMENT_TARGET_SPECS: Record<string, CommentTargetSpec> = {
  reddit: {
    authorPath: 'user.name',
    candidateIdPaths: ['post.permalink'],
    draftIdKeys: ['permalink'],
  },
  mastodon: {
    authorPath: 'author.acct',
    candidateIdPaths: ['status.id', 'status.url'],
    draftIdKeys: ['statusId', 'statusUrl'],
  },
  linkedin: {
    // `author.handle` is the profile slug; `author.name` sits next to it and is
    // deliberately not used (see CommentTargetSpec.authorPath). An observation
    // captured without a slug therefore yields no target, which is the same
    // rule the LinkedIn drain applies before it blocklist-checks a candidate.
    authorPath: 'author.handle',
    candidateIdPaths: ['post.externalId', 'post.url'],
    draftIdKeys: ['externalId', 'url'],
  },
};

export function commentTargetSpec(
  platformSlug: string | null | undefined,
): CommentTargetSpec | null {
  if (!platformSlug) return null;
  return COMMENT_TARGET_SPECS[platformSlug] ?? null;
}

function at(source: unknown, path: string): unknown {
  let cursor: unknown = source;
  for (const key of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * One comparable form for a post identifier, so a candidate's Reddit permalink
 * (`/r/x/comments/abc/slug/`) still matches a draft that wrote it as a full
 * URL, and a Mastodon status id matches itself. Scheme and host go, the query
 * and fragment go, case and the trailing slash are normalised. Numbers are
 * accepted because a numeric id (HN, Mastodon) reaches JSON as one.
 */
export function normalizePostId(value: unknown): string | null {
  let raw: string;
  if (typeof value === 'string') raw = value;
  else if (typeof value === 'number' && Number.isFinite(value)) raw = String(value);
  else return null;

  let s = raw.trim();
  if (s === '' || s.length > 512) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  s = s.split('#')[0].split('?')[0];
  s = s.replace(/\/+$/, '');
  s = s.toLowerCase();
  return s === '' ? null : s;
}

/**
 * Post identifier -> author handle, over one run's staged candidates. An
 * identifier two candidates disagree about maps to `null`: an ambiguous match
 * is worse than none, since the wrong handle would enter `contact_history`
 * under the dedup key of a person who was never contacted.
 */
export function indexCandidateAuthors(
  spec: CommentTargetSpec,
  raws: unknown[],
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const raw of raws) {
    const author = at(raw, spec.authorPath);
    if (typeof author !== 'string' || author.trim() === '') continue;
    const handle = author.trim();
    for (const path of spec.candidateIdPaths) {
      const id = normalizePostId(at(raw, path));
      if (id == null) continue;
      if (!index.has(id)) index.set(id, handle);
      else if (index.get(id) !== handle) index.set(id, null);
    }
  }
  return index;
}

/**
 * The author of the post a draft comments on, or null when the run's
 * candidates cannot name one. Never guesses: only an identifier the draft
 * itself carries is looked up.
 */
export function resolveCommentTargetUser(
  spec: CommentTargetSpec,
  index: Map<string, string | null>,
  draft: { sourceRef?: Record<string, unknown>; metadata?: Record<string, unknown> },
): string | null {
  for (const key of spec.draftIdKeys) {
    for (const source of [draft.sourceRef, draft.metadata]) {
      const id = normalizePostId(source?.[key]);
      if (id == null) continue;
      const handle = index.get(id);
      if (handle) return handle;
    }
  }
  return null;
}
