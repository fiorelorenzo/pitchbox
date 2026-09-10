import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import './custom.css';

// LOR-199: the only reason this theme exists - a small wrapping `Layout`
// that closes the default theme's missing main-landmark gap on the home
// page (see Layout.vue) plus a one-rule contrast fix for the hero's brand
// button (see custom.css). Everything else - nav, sidebar, content, footer,
// search - stays exactly what `DefaultTheme` already renders.
export default {
  extends: DefaultTheme,
  Layout,
} satisfies Theme;
