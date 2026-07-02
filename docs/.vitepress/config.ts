import { defineConfig } from 'vitepress';

export default defineConfig({
  // Bind the dev server to localhost (IPv4) so it is not exposed on the network.
  vite: { server: { host: '127.0.0.1' } },
  // Served from https://fiorelorenzo.github.io/pitchbox/ - without this prefix
  // the built site requests assets from the apex domain and renders unstyled.
  base: '/pitchbox/',
  title: 'Pitchbox',
  description: 'Self-hosted, human-in-the-loop outreach agent for Reddit (and beyond).',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['superpowers/**'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Concepts', link: '/concepts' },
      { text: 'GitHub', link: 'https://github.com/fiorelorenzo/pitchbox' },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Getting started', link: '/getting-started' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Projects · accounts · campaigns', link: '/concepts' },
          { text: 'Agent runners', link: '/runners' },
          { text: 'Playbooks', link: '/playbooks' },
          { text: 'Notifications', link: '/notifications' },
          { text: 'Authentication', link: '/auth' },
        ],
      },
      {
        text: 'Surfaces',
        items: [
          { text: 'Chrome extension', link: '/extension' },
          { text: 'Daemon', link: '/daemon' },
          { text: 'CLI', link: '/cli' },
          { text: 'HTTP API', link: '/api' },
        ],
      },
      {
        text: 'Operations',
        items: [{ text: 'Self-hosting', link: '/self-hosting' }],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/fiorelorenzo/pitchbox' }],
    footer: {
      message: 'AGPL-3.0-or-later · Pitchbox',
    },
  },
});
