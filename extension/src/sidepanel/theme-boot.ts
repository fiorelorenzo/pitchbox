/**
 * Applies the stored theme + density before the app mounts, so the panel does
 * not flash the wrong palette on open.
 *
 * This lived as an inline `<script>` in index.html until it was loaded from a
 * real install rather than `vite dev`. MV3's default extension CSP is
 * `script-src 'self'`, which has no `unsafe-inline` and cannot be relaxed for
 * an extension page, so Chrome refused to execute it: "Executing inline script
 * violates the following Content Security Policy directive 'script-src
 * 'self''". The panel still rendered, which is why it survived review, but the
 * theme was never applied and every open logged an error that surfaces as a
 * red "Errors" badge on chrome://extensions.
 *
 * Kept as its own module rather than folded into main.ts because it has to run
 * before the app's own imports are evaluated: module scripts execute in
 * document order, so this one wins.
 */
document.documentElement.style.visibility = 'hidden';

void (async () => {
  try {
    const out = (await chrome.storage.local.get('extensionSettings')) as {
      extensionSettings?: { theme?: string; density?: string };
    };
    const s = out.extensionSettings ?? {};
    const theme = s.theme ?? 'system';
    const density = s.density ?? 'comfortable';
    const isDark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) document.documentElement.classList.add('dark');
    if (density === 'compact') document.documentElement.classList.add('density-compact');
  } finally {
    document.documentElement.style.visibility = '';
  }
})();
