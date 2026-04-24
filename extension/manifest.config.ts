import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Pitchbox',
  description: 'Companion extension for the Pitchbox outreach dashboard.',
  version: pkg.version,
  icons: {
    48: 'public/icon-48.png',
    128: 'public/icon-128.png',
  },
  action: {
    default_title: 'Pitchbox',
    default_popup: 'src/popup/index.html',
    default_icon: { 48: 'public/icon-48.png' },
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
      // The Matrix token lives in reddit.com's localStorage (per-origin), so any
      // reddit.com page works — no need to be on /chat. The chat also appears as
      // a side-panel widget from any reddit.com page.
      matches: ['https://www.reddit.com/*'],
      js: ['src/content/chat-token.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage', 'alarms'],
  host_permissions: [
    'https://www.reddit.com/*',
    'https://old.reddit.com/*',
    'https://matrix.redditspace.com/*',
    'http://127.0.0.1/*',
    'http://localhost/*',
  ],
});
