import { describe, expect, it } from 'vitest';
import { translate } from '../../src/lib/i18n/index.js';

// #403: proves the Activity list a human actually reads renders sentences,
// not a raw message key next to a JSON params blob.
//
// This does not mount `ActivityRow.svelte` (its render is the one-line
// `$t(event.message, event.messageParams)` asserted statically below) via a
// real Svelte `mount()`: that component imports through the `$ext`/`$ui`
// aliases extension/vite.config.ts defines, which only the extension's own
// `vitest.config.ts` merges in - the root `vitest.config.ts` (what
// `pnpm exec vitest run` from the repo root and the `preflight` pre-push
// hook actually run) only knows `$lib` for `web/`, so a real mount of this
// component fails there with an unresolved import. `translate()` is the
// entire rendering logic ActivityRow hands `event.message`/`messageParams`
// to, so exercising it directly with the same arguments the component
// passes is equivalent proof without depending on aliases the root suite
// does not have.
//
// Covers the three kinds of entry a human actually reads when something
// went wrong, per #403: a LinkedIn action, a sync run, and a refusal/failure.
const ACTIVITY_ROW_SOURCE = (
  import.meta.glob('../../src/sidepanel/components/ActivityRow.svelte', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>
)['../../src/sidepanel/components/ActivityRow.svelte'];

describe('ActivityRow renders a sentence, not a raw key', () => {
  it('still hands the raw message and its params to $t, not a pre-rendered string', () => {
    expect(ACTIVITY_ROW_SOURCE).toContain('$t(event.message, event.messageParams)');
    // The historical bug shape #403 reports: the key printed next to a
    // stringified params object.
    expect(ACTIVITY_ROW_SOURCE).not.toMatch(/JSON\.stringify\(\s*event\.messageParams/);
  });

  it('EN: a LinkedIn action entry reads as a sentence', () => {
    expect(
      translate('en', 'activity.linkedin-action.assist-mounted', {
        pageKind: 'feed-sdui',
        card: 'unresolved',
      }),
    ).toBe('Comment assist opened on the feed-sdui page, with the post card unresolved.');
  });

  it('IT: the same LinkedIn action entry reads as a sentence', () => {
    expect(
      translate('it', 'activity.linkedin-action.assist-mounted', {
        pageKind: 'feed-sdui',
        card: 'unresolved',
      }),
    ).toBe('Assistente commento aperto sulla pagina feed-sdui, con la card del post unresolved.');
  });

  it('EN: a sync entry reads as a sentence', () => {
    expect(translate('en', 'activity.dm-sync.ok', { inserted: 3, replied: 1 })).toBe(
      'Reddit inbox sync - 3 new, 1 replied.',
    );
  });

  it('IT: the same sync entry reads as a sentence', () => {
    expect(translate('it', 'activity.dm-sync.ok', { inserted: 3, replied: 1 })).toBe(
      'Sync inbox Reddit - 3 nuovi, 1 risposti.',
    );
  });

  it('EN: a refusal reads as a sentence naming what failed, not what the code did', () => {
    expect(
      translate('en', 'activity.linkedin-action.suggestion-refused', {
        reason: 'quota_exhausted',
      }),
    ).toBe('LinkedIn assist suggestion refused: quota_exhausted');
  });

  it('IT: the same refusal reads as a sentence', () => {
    expect(
      translate('it', 'activity.linkedin-action.suggestion-refused', {
        reason: 'quota_exhausted',
      }),
    ).toBe('Suggerimento LinkedIn assist rifiutato: quota_exhausted');
  });
});
