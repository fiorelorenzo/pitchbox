import { defineConfig } from 'vitepress';

export default defineConfig({
  // Bind the dev server to localhost (IPv4) so it is not exposed on the network.
  vite: { server: { host: '127.0.0.1' } },
  // Served from https://docs.pitchbox.app, so no path prefix: the site is at
  // the root of its own host. This replaces the `base: '/pitchbox/'` that
  // GitHub Pages' project-site path needed (D25, docs/design/DECISIONS.md);
  // D38 supersedes it. Still GitHub Pages underneath - a Pages custom
  // domain, not a prodbox vhost - so the TLS and CDN argument behind D25
  // still holds and nothing moved to Caddy. The domain itself lives in the
  // repo's Pages settings, not in this file and not in `public/CNAME`:
  // measured 2026-09-10, a workflow-built deploy carrying that file left
  // `cname` null until `PUT /repos/{owner}/{repo}/pages` set it.
  title: 'Pitchbox',
  description: 'Self-hosted, human-in-the-loop outreach agent for Reddit (and beyond).',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['superpowers/**'],
  sitemap: { hostname: 'https://docs.pitchbox.app' },
  // Syntax colours are the one set of values that cannot come from our token
  // layer, so they are picked for contrast against it and measured. VitePress
  // defaults to `github-dark`, whose comment token (#6a737d) is 3.72:1 on our
  // dark code surface; `github-dark-dimmed`'s is 4.63:1 and clears AA. The
  // light pair already passes on ours.
  markdown: { theme: { light: 'github-light', dark: 'github-dark-dimmed' } },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['link', { rel: 'alternate icon', type: 'image/png', href: '/favicon-32.png' }],
    ['meta', { name: 'theme-color', content: '#0a0a0a' }],
  ],
  themeConfig: {
    // Decorative: the site title next to it already says "Pitchbox", and a
    // repeated alt is an axe `image-redundant-alt` finding.
    logo: { src: '/favicon.svg', alt: '' },
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Concepts', link: '/concepts' },
      { text: 'Website', link: 'https://pitchbox.app' },
      { text: 'Open the app', link: 'https://app.pitchbox.app' },
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
          { text: "Why a draft doesn't read as AI", link: '/voice' },
          { text: 'The two languages', link: '/languages' },
          { text: 'Agent runners', link: '/runners' },
          { text: 'Playbooks', link: '/playbooks' },
          { text: 'Notifications', link: '/notifications' },
          { text: 'Authentication', link: '/auth' },
          { text: 'Organizations', link: '/orgs' },
          { text: 'Permissions', link: '/permissions' },
          { text: 'Analytics', link: '/analytics' },
        ],
      },
      {
        text: 'Platforms',
        items: [
          { text: 'LinkedIn', link: '/platforms/linkedin' },
          { text: 'Hacker News', link: '/platforms/hackernews' },
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
        items: [
          { text: 'Self-hosting', link: '/self-hosting' },
          { text: 'Retention', link: '/retention' },
          { text: 'Billing', link: '/billing' },
        ],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/fiorelorenzo/pitchbox' }],
    footer: {
      message: 'AGPL-3.0-or-later · Pitchbox',
    },
  },
});
