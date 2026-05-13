import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { applyTheme } from '../lib/theme.js';
import { getSettings } from '../lib/settings.js';
import { resolveInitialLocale, setLocale } from '../lib/i18n/index.js';

async function boot(): Promise<void> {
  const s = await getSettings();
  applyTheme(s.theme);
  if (s.density === 'compact') document.documentElement.classList.add('density-compact');
  setLocale(s.locale || (await resolveInitialLocale()));
  mount(App, { target: document.getElementById('app')! });
}

void boot();
