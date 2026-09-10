import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import '@fontsource-variable/inter';
import './tokens.css';
import './custom.css';

// Two reasons this theme exists, and neither is a redesign of the default one:
// the product's palette and typography on top of it (`tokens.css` +
// `custom.css`, D39), and a small wrapping `Layout` that closes the default
// theme's missing main-landmark gap on the home page (`Layout.vue`, LOR-199).
// Everything else - nav, sidebar, content, footer, search - stays exactly what
// `DefaultTheme` already renders, since the docs are prose and a real component
// override here would be a second design system to keep in step with the app's.
export default {
  extends: DefaultTheme,
  Layout,
} satisfies Theme;
