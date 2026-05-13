import type { ThemeMode } from './settings.js';

let detach: (() => void) | null = null;

function setDarkClass(on: boolean): void {
  const html = document.documentElement;
  if (on) html.classList.add('dark');
  else html.classList.remove('dark');
}

export function applyTheme(mode: ThemeMode): void {
  if (detach) {
    detach();
    detach = null;
  }
  if (mode === 'dark') {
    setDarkClass(true);
    return;
  }
  if (mode === 'light') {
    setDarkClass(false);
    return;
  }
  // system
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  setDarkClass(mql.matches);
  const handler = (e: { matches: boolean }) => setDarkClass(e.matches);
  mql.addEventListener('change', handler);
  detach = () => mql.removeEventListener('change', handler);
}
