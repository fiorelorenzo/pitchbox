type LookupArgs = {
  postId: string; // e.g. '1q950mt' (no t3_ prefix)
  accountHandle: string;
  postedAtMs: number; // ms epoch when the user clicked Send
};

const GRACE_MS = 30_000;

type RedditCommentJson = {
  data?: {
    children?: Array<{
      kind?: string;
      data?: { name?: string; author?: string; created_utc?: number };
    }>;
  };
};

/**
 * Best-effort: fetch the latest top-level comments on a post, return the t1
 * thing_id of the comment authored by `accountHandle` whose `created_utc` is
 * within GRACE_MS of `postedAtMs`. One retry after 5s on miss.
 */
export async function findOurComment(args: LookupArgs): Promise<string | null> {
  const url = `https://www.reddit.com/comments/${args.postId}.json?sort=new&depth=1&limit=10&raw_json=1`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5_000));
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const data = (await res.json()) as RedditCommentJson[];
      // Reddit returns [post, comments]. Comments listing is data[1].
      const listing = Array.isArray(data) ? data[1] : data;
      const children = listing?.data?.children ?? [];
      const wanted = args.accountHandle.toLowerCase();
      const lowerBound = (args.postedAtMs - GRACE_MS) / 1000;
      for (const c of children) {
        if (c.kind !== 't1' || !c.data) continue;
        if ((c.data.author ?? '').toLowerCase() !== wanted) continue;
        if ((c.data.created_utc ?? 0) < lowerBound) continue;
        if (c.data.name) return c.data.name;
      }
    } catch {
      // ignore, retry
    }
  }
  return null;
}
