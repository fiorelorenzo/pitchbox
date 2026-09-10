import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@pitchbox/shared/db';
import type { AgentRunHandle, AgentRunOptions, AgentRunner } from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';
import { REWRITE_MARKER } from '@pitchbox/shared/style-check';

/**
 * #572: the assist plane's targeted-rewrite round trip. `enforceHouseStyle`
 * itself is exercised directly against a mock rewrite function in
 * `shared/tests/style-check.test.ts`; what these defend is that
 * `runSuggestion` actually wires it in - a second turn on the same runner,
 * naming the remaining finding, with the draft and findings the caller
 * receives reflecting the outcome of that turn.
 *
 * The agent is faked exactly like `extension-suggest.test.ts` fakes it, but
 * distinguishes the suggestion turn from the rewrite turn by `opts.slug`, so
 * each can answer differently.
 */

const callSlugs: string[] = [];
let secondTurnReply = '';

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'fake',
    run(opts: AgentRunOptions): AgentRunHandle {
      callSlugs.push(opts.slug);
      if (opts.slug === 'assist-style-rewrite') {
        opts.onTextChunk?.(secondTurnReply);
      } else {
        // An em dash (mechanically repairable) plus a rhetorical-question
        // opener (structural: goes to the round trip).
        opts.onTextChunk?.(
          `Noticed the thing.\n${DRAFT_MARKER}\n` +
            'Ever wondered why builds are slow\u2014ours got faster this week?',
        );
      }
      return {
        result: Promise.resolve({ exitCode: 0, logPath: '/dev/null' }),
        cancel: () => {},
      };
    },
  }),
}));

const { runSuggestion } = await import('../src/lib/server/suggest.js');

async function reset() {
  await getDb().execute(sql`TRUNCATE app_config RESTART IDENTITY CASCADE`);
  callSlugs.length = 0;
}

function baseArgs() {
  return {
    kind: 'post_comment' as const,
    post: { urn: 'urn:li:activity:1', authorName: 'A', text: 'hi' },
    persona: null,
    voiceProfile: null,
    projects: [],
    repos: [],
    runnerSlug: 'claude-code',
  };
}

describe('runSuggestion: house-style enforcement round trip (#572)', () => {
  it('mechanically repairs the em dash and accepts a clean single rewrite of the remaining finding', async () => {
    await reset();
    secondTurnReply = `${REWRITE_MARKER}\nBuilds were slow this week because of a missing cache key, now fixed.`;

    const handle = runSuggestion(baseArgs());
    const result = await handle.result;

    // The suggestion turn, then exactly one rewrite turn - never more.
    expect(callSlugs).toEqual(['assist-post_comment', 'assist-style-rewrite']);
    expect(result.draft).toBe(
      'Builds were slow this week because of a missing cache key, now fixed.',
    );
    expect(result.styleFindings ?? []).toEqual([]);
  });

  it('shows the finding rather than silently accepting a draft the rewrite could not fix', async () => {
    await reset();
    // No REWRITE_MARKER: a non-compliant reply, treated as a failed rewrite.
    secondTurnReply = 'Sure, here is a rewrite of that sentence for you.';

    const handle = runSuggestion(baseArgs());
    const result = await handle.result;

    expect(callSlugs).toEqual(['assist-post_comment', 'assist-style-rewrite']);
    // The em dash is still mechanically repaired even though the rewrite
    // failed - that half of the check never depends on the model at all.
    expect(result.draft).toBe('Ever wondered why builds are slow, ours got faster this week?');
    expect(result.styleFindings?.map((f) => f.ruleId)).toContain('rhetorical-question-opener');
  });
});
