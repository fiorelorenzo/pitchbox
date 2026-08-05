import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DraftInput } from '../../src/commands/drafts.js';

/**
 * The playbooks are the prompt. Whatever JSON they show an agent is what the
 * agent sends to `drafts_create`, so the documented example and the schema
 * that validates it are one contract, and nothing was checking it.
 *
 * They had already drifted. Every commenter and poster playbook, on all three
 * platforms, documents `"targetUser": null` for a draft whose audience is a
 * thread rather than one user. Zod's `.optional()` accepts a missing key but
 * not an explicit null, so a literal, compliant payload failed validation and
 * the agent lost the whole batch with "invalid payload" (found while closing
 * #258; the database had never held a single post or post_comment draft).
 *
 * This walks the real files rather than restating their contents, so a new
 * playbook, or a new field in an old one, is covered the day it lands.
 */

const PLAYBOOKS = join(process.cwd(), 'playbooks');

/** Every fenced ```json block in a markdown file, parsed. Unparseable blocks
 * are surfaced rather than skipped: a malformed example is its own defect. */
function jsonBlocks(markdown: string, file: string): unknown[] {
  const blocks: unknown[] = [];
  for (const m of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    const raw = m[1];
    try {
      blocks.push(JSON.parse(raw));
    } catch (err) {
      throw new Error(`${file} has a \`\`\`json block that is not valid JSON`, { cause: err });
    }
  }
  return blocks;
}

/** A block is a draft payload when it carries the two fields every draft must
 * have. Playbooks also embed run_finish, profile and insight payloads. */
function isDraftLike(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' && v !== null && 'accountId' in v && 'kind' in v && !Array.isArray(v)
  );
}

function draftExamples(): { file: string; draft: Record<string, unknown> }[] {
  const found: { file: string; draft: Record<string, unknown> }[] = [];
  for (const file of readdirSync(PLAYBOOKS).filter((f) => f.endsWith('.md'))) {
    const body = readFileSync(join(PLAYBOOKS, file), 'utf8');
    for (const block of jsonBlocks(body, file)) {
      const candidates = Array.isArray(block) ? block : [block];
      for (const c of candidates) if (isDraftLike(c)) found.push({ file, draft: c });
    }
  }
  return found;
}

describe('playbook draft payloads validate against the schema that receives them', () => {
  const examples = draftExamples();

  it('finds the documented examples at all, so a silent zero never passes this file', () => {
    const files = new Set(examples.map((e) => e.file));
    // Reddit, HN and Mastodon each document a poster and a commenter payload.
    expect(examples.length).toBeGreaterThanOrEqual(6);
    expect(files.size).toBeGreaterThanOrEqual(6);
  });

  it.each(examples.map((e, i) => [`${e.file} #${i}`, e.draft] as const))(
    '%s parses',
    (label, draft) => {
      const parsed = DraftInput.safeParse(draft);
      if (!parsed.success) {
        throw new Error(
          `${label} is documented in a playbook but rejected by DraftInput: ` +
            JSON.stringify(parsed.error.issues),
        );
      }
    },
  );

  it('treats an explicit null as an absent field rather than a value', () => {
    const parsed = DraftInput.parse({
      accountId: 1,
      kind: 'post_comment',
      body: 'a comment',
      subreddit: 'rpg',
      targetUser: null,
      title: null,
      composeUrl: null,
      fitScore: null,
      metadata: null,
      sourceRef: null,
    });
    // Null collapses to undefined, so downstream code keeps two states, not three.
    expect(parsed.targetUser).toBeUndefined();
    expect(parsed.title).toBeUndefined();
    expect(parsed.composeUrl).toBeUndefined();
    expect(parsed.fitScore).toBeUndefined();
    // The containers still default, which `.default()` alone would not do for null.
    expect(parsed.metadata).toEqual({});
    expect(parsed.sourceRef).toEqual({});
  });

  it('still rejects a wrong type, so tolerance of null is not tolerance of anything', () => {
    const parsed = DraftInput.safeParse({
      accountId: 1,
      kind: 'post_comment',
      body: 'a comment',
      targetUser: 42,
    });
    expect(parsed.success).toBe(false);
  });
});
