// @vitest-environment jsdom
//
// The description band's one contract: what it renders is the project's
// description as the server last told it, unless the operator is editing.
//
// It did not hold. `description` was a local `$state` seeded once at mount
// and re-synced by an effect that only wrote when the local copy was empty,
// so a project that already had a description kept showing the old text
// after a run rewrote it - the SSE `project:description:updated` handler was
// the only thing that ever wrote the new one, and that event has no replay:
// a reconnect inside the several minutes a run takes, or a tab opened
// mid-run, loses it and the operator has to reload the page by hand. That is
// exactly what Lorenzo reported on 2026-09-12.
//
// So this drives the real compiled component through the two states that
// matter: an upstream description change with nobody editing (must appear),
// and the same change while the operator is editing (must NOT clobber the
// buffer).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync, type ComponentProps } from 'svelte';
import ProjectOverviewTab from '../src/lib/components/projects/ProjectOverviewTab.svelte';
import { __page } from './support/app-stores.js';
import { reactiveProps } from './support/reactive-props.svelte.js';

type Props = ComponentProps<typeof ProjectOverviewTab>;

const project = {
  id: 7,
  slug: 'demo',
  name: 'Demo',
  description: 'The old description, written before the run.',
  defaultAgentRunner: 'cloud',
  voiceTone: null,
  voiceToneNotes: null,
};

let component: Record<string, unknown> | null = null;
let props: Props;

function render(overrides: Partial<Props> = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  props = reactiveProps({
    project: { ...project },
    extractionRuns: [],
    extractionRunsTotalCount: 0,
    extractionRunsNextCursor: null,
    recommendations: [],
    isAdmin: true,
    runners: [{ slug: 'cloud', label: 'Pitchbox Cloud', implemented: true }],
    sources: [
      {
        id: 1,
        kind: 'website',
        config: { url: 'https://example.com' },
        output: { text: 'x' },
        active: true,
        fetchedAt: new Date().toISOString(),
        fetchError: null,
      },
    ],
    ...overrides,
  });
  component = mount(ProjectOverviewTab, { target: host, props }) as Record<string, unknown>;
  flushSync();
  return host;
}

function bandText(el: HTMLElement): string {
  return el.textContent ?? '';
}

beforeEach(() => {
  __page.set({ data: { locale: 'en' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200 })),
  );
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the project description band', () => {
  it('shows a description the server changed under it, with no reload', async () => {
    const el = render();
    await vi.waitFor(() =>
      expect(bandText(el)).toContain('The old description, written before the run.'),
    );

    // What `invalidateAll()` delivers after a run finishes.
    props.project = {
      ...project,
      description: 'What the agent wrote from the sources.',
    };
    flushSync();

    await vi.waitFor(() =>
      expect(bandText(el)).toContain('What the agent wrote from the sources.'),
    );
    expect(bandText(el)).not.toContain('The old description, written before the run.');
  });

  it('leaves an in-progress edit alone when the upstream description changes', async () => {
    const el = render();
    await vi.waitFor(() => expect(bandText(el)).toContain('The old description'));

    const edit = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Edit',
    );
    if (!edit) throw new Error('Edit button not found');
    edit.click();
    flushSync();

    props.project = { ...project, description: 'A concurrent rewrite.' };
    flushSync();

    // The editor is the buffer's, not the prop's: the operator's text stays.
    await vi.waitFor(() => expect(bandText(el)).not.toContain('A concurrent rewrite.'));
  });

  it('offers the run action next to the description, unadorned', async () => {
    const el = render();
    const write = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Write from sources',
    );
    if (!write) throw new Error('"Write from sources" button not found');
    // It used to be the sources card's header button and the only iconed
    // button on the page; both halves of that are the defect.
    expect(write.querySelector('svg')).toBeNull();
    expect(write.disabled).toBe(false);
  });

  it('disables the run action when no source is active', async () => {
    const el = render({ sources: [] });
    const write = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Write from sources',
    );
    if (!write) throw new Error('"Write from sources" button not found');
    expect(write.disabled).toBe(true);
  });
});
