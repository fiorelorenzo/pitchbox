// What the extractor agent actually reads (#434). `project_extract_sources`
// hands the agent whatever each fetcher cached, and this module is the one
// translation between a fetcher's own jsonb and the text a prompt carries.
//
// A regression here is invisible from the outside: the run still succeeds,
// the description still gets written, and it is simply written from less
// than the operator provided - the failure mode that produced a "sources
// appendix" instead of a description in the first place. So this pins what
// reaches the agent per kind, not the shape of the function.
//
// Pure functions over a row object, no database: `viewProjectSourceForAgent`
// only reads columns.
import { describe, expect, it } from 'vitest';
import {
  projectSourceLabel,
  viewProjectSourceForAgent,
  SOURCE_CONTENT_MAX_CHARS,
  type AgentSourceView,
} from '../src/project-source-content.js';
import type { ProjectSourceRow } from '../src/project-sources.js';

function row(over: Partial<ProjectSourceRow>): ProjectSourceRow {
  return {
    id: 1,
    projectId: 1,
    kind: 'website',
    config: {},
    output: null,
    active: true,
    fetchedAt: null,
    fetchError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as ProjectSourceRow;
}

function view(over: Partial<ProjectSourceRow>): AgentSourceView {
  return viewProjectSourceForAgent(row(over));
}

describe('projectSourceLabel', () => {
  it('reads each kind from the key its own fetcher writes, not one assumed name', () => {
    expect(projectSourceLabel(row({ kind: 'website', config: { url: 'https://a.example' } }))).toBe(
      'https://a.example',
    );
    expect(
      projectSourceLabel(
        row({
          kind: 'mastodon_account',
          config: { instanceUrl: 'https://m.example', acct: 'alice' },
        }),
      ),
    ).toBe('https://m.example/@alice');
    expect(projectSourceLabel(row({ kind: 'hackernews_author', config: { username: 'pg' } }))).toBe(
      'pg',
    );
    expect(
      projectSourceLabel(row({ kind: 'git', config: { value: 'https://github.com/acme/widget' } })),
    ).toBe('https://github.com/acme/widget');
  });

  it('falls back to config.url for a git row migrated from the old github kind', () => {
    // Migration 0018 wrote `{ owner, repo, url }` with no `value`; 0038
    // backfills it, but a reader that only knew `value` would label those
    // rows empty and hand the agent a source it cannot cite.
    expect(
      projectSourceLabel(
        row({
          kind: 'git',
          config: { owner: 'acme', repo: 'widget', url: 'https://github.com/acme/widget' },
        }),
      ),
    ).toBe('https://github.com/acme/widget');
  });
});

describe('viewProjectSourceForAgent', () => {
  it('marks a file tree as one, and hands it no text of its own', () => {
    for (const kind of ['folder', 'git', 'upload'] as const) {
      const v = view({ kind, config: { value: '/tmp/x' }, output: { text: 'ignored' } });
      expect(v.readsAsTree).toBe(true);
      // A tree is read through project_extract_files/_read. Returning its
      // cached metadata as `content` too would let the agent describe a
      // repository from a README excerpt while believing it read the tree.
      expect(v.content).toBeNull();
    }
  });

  it("carries a website's crawled text and how much of the site it covers", () => {
    const v = view({
      kind: 'website',
      config: { url: 'https://a.example' },
      output: { url: 'https://a.example', text: 'We sell widgets.', fetchedPageCount: 3 },
    });
    expect(v.readsAsTree).toBe(false);
    expect(v.content).toContain('We sell widgets.');
    expect(v.content).toContain('3');
  });

  it('carries a LinkedIn profile capture as prose, experiences included', () => {
    const v = view({
      kind: 'linkedin_profile',
      config: { value: 'https://www.linkedin.com/in/example', identifier: 'example' },
      output: {
        handle: 'example',
        displayName: 'Alice Example',
        headline: 'Fractional CTO',
        about: 'Ten years shipping products.',
        experiences: [
          { title: 'CTO', company: 'Acme', period: '2024 - now', summary: 'Owns the platform.' },
          { title: 'Engineer', company: null, period: null, summary: null },
        ],
      },
    });
    expect(v.content).toContain('Alice Example');
    expect(v.content).toContain('Fractional CTO');
    expect(v.content).toContain('Ten years shipping products.');
    expect(v.content).toContain('CTO - Acme - 2024 - now');
    expect(v.content).toContain('Owns the platform.');
    // A partial experience contributes what it has rather than rendering
    // "null" into the prompt.
    expect(v.content).toContain('Engineer');
    expect(v.content).not.toContain('null');
  });

  it("reports a source nothing filled as empty, with the fetcher's own reason", () => {
    const v = view({
      kind: 'website',
      config: { url: 'https://down.example' },
      output: null,
      fetchError: 'network error: getaddrinfo ENOTFOUND down.example',
    });
    expect(v.content).toBeNull();
    expect(v.fetchError).toMatch(/ENOTFOUND/);
    expect(v.truncated).toBe(false);
  });

  it('truncates one pathological source instead of crowding out the others', () => {
    const v = view({
      kind: 'website',
      config: { url: 'https://big.example' },
      output: { text: 'x'.repeat(SOURCE_CONTENT_MAX_CHARS + 5_000) },
    });
    expect(v.truncated).toBe(true);
    expect(v.content!.length).toBe(SOURCE_CONTENT_MAX_CHARS);
  });
});
