/**
 * Turns the SSE `status` event's `phase` (#573) into the one line the panel
 * shows next to the skeleton (D12, D27 in docs/design/DECISIONS.md). Shared
 * between `linkedin-comment-assist-panel.svelte` and
 * `linkedin-post-assist-panel.svelte`, which must never each invent their
 * own wording for the same phase.
 *
 * `phase` arrives as one of three fixed values (`reading`, `writing`,
 * `slow`) or, while a tool step is running, a comma-joined set of the tool
 * names the loop is actually running that step
 * (`web/src/routes/api/extension/suggest/+server.ts`'s own `onToolStep`
 * wiring, `toolNames.join(',')`). Each recognised tool name maps to its own
 * lowercase clause in the operator's own words - D27's quoted examples
 * ("reading the thread", "looking at the image", "checking your prior
 * takes") are exactly the single-tool case below - and several running at
 * once (`docs/design/in-page-agent.md`'s parallelism section) are joined
 * the way a human would list them, via `Intl.ListFormat`, rather than
 * rendered as separate lines: the panel is never quiet for longer than a
 * step, but it also never scrolls through five lines for one. A tool name
 * this build does not recognise still renders, as a generic "still working
 * on it" clause, rather than a raw identifier or nothing.
 */

const STEP_KEYS: Record<string, string> = {
  read_thread: 'assist.status.step.read_thread',
  look_at_image: 'assist.status.step.look_at_image',
  author_history: 'assist.status.step.author_history',
  operator_voice: 'assist.status.step.operator_voice',
  project_knowledge: 'assist.status.step.project_knowledge',
  my_prior_takes: 'assist.status.step.my_prior_takes',
  check_style: 'assist.status.step.check_style',
};

/**
 * `t`/`locale` are passed in rather than imported from `lib/i18n/index.js`
 * directly so this stays reactive to the caller's own `$t`/`$locale` store
 * subscriptions instead of reading a snapshot - both panels already hold
 * both live.
 */
export function describeStatus(
  phase: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
): string {
  if (phase === 'reading' || phase === '') return t('assist.status.reading');
  if (phase === 'writing') return t('assist.status.writing');
  if (phase === 'slow') return t('assist.status.slow');

  const names = phase.split(',').filter(Boolean);
  if (names.length === 0) return t('assist.status.reading');

  const phrases = names.map((name) => t(STEP_KEYS[name] ?? 'assist.status.step.unknown'));
  const joined = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
    phrases,
  );
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}…`;
}
