import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Pitchbox',
  description: 'Companion extension for the Pitchbox outreach dashboard.',
  version: pkg.version,
  icons: {
    16: 'public/icons/icon-16.png',
    32: 'public/icons/icon-32.png',
    48: 'public/icons/icon-48.png',
    128: 'public/icons/icon-128.png',
  },
  action: {
    default_title: 'Pitchbox',
    default_icon: {
      16: 'public/icons/icon-16.png',
      32: 'public/icons/icon-32.png',
      48: 'public/icons/icon-48.png',
      128: 'public/icons/icon-128.png',
    },
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: [
        'https://www.reddit.com/message/compose*',
        'https://old.reddit.com/message/compose*',
      ],
      js: ['src/content/dm-compose.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://www.reddit.com/r/*/comments/*', 'https://old.reddit.com/r/*/comments/*'],
      js: ['src/content/post-comment.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://www.reddit.com/r/*/submit*', 'https://old.reddit.com/r/*/submit*'],
      js: ['src/content/post-submit.ts'],
      run_at: 'document_idle',
    },
    {
      // The Matrix token lives in reddit.com's localStorage (per-origin), so any
      // reddit.com page works — no need to be on /chat. The chat also appears as
      // a side-panel widget from any reddit.com page.
      matches: ['https://www.reddit.com/*'],
      js: ['src/content/chat-token.ts'],
      run_at: 'document_idle',
    },
    {
      // Auto-pair on the cloud edition. Self-hosted instances trigger the
      // same script on demand via the popup's "Pair with this tab" button,
      // which uses chrome.scripting.executeScript after a one-shot
      // permission grant.
      matches: ['https://app.pitchbox.io/*', 'http://127.0.0.1:5180/*', 'http://localhost:5180/*'],
      js: ['src/content/auto-pair.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage', 'alarms', 'tabs', 'scripting', 'sidePanel'],
  optional_host_permissions: ['<all_urls>'],
  host_permissions: [
    'https://www.reddit.com/*',
    'https://old.reddit.com/*',
    'https://matrix.redditspace.com/*',
    'https://app.pitchbox.io/*',
    'http://127.0.0.1/*',
    'http://localhost/*',
  ],
});
