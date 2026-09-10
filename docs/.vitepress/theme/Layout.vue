<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { useRoute } from 'vitepress';
import { nextTick, watch } from 'vue';

// VitePress's own VPContent.vue (the default theme, not this repo) renders
// the page body as a plain `<div id="VPContent">` with no landmark role at
// all. A normal doc page is fine regardless - VPDoc wraps its own content in
// a real `<main>` - but the `layout: home` page (VPHome.vue, used by
// docs/index.md) never renders one, so axe flags the whole page with zero
// main landmarks (`landmark-one-main`, `region` - LOR-199). No newer
// VitePress fixes this: 1.6.4 is already the latest release.
//
// Marking `#VPContent` `role="main"` only when it has no `<main>` already
// nested inside it closes both, on every current and future layout, without
// forking VPHome (or VPDoc, or any other theme component) - and without
// duplicating VPDoc's own `<main>`, which would trip axe's
// `landmark-no-duplicate-main` on every ordinary doc page instead.
function markMainLandmark(): void {
  const content = document.getElementById('VPContent');
  if (!content) return;
  if (content.querySelector('main')) content.removeAttribute('role');
  else content.setAttribute('role', 'main');
}

// Client-only: SSR (`vitepress build`'s prerender pass) has no `document` to
// patch, and the client hydrates every prerendered page on load anyway, so
// nothing here needs to run server-side. `flush: 'post'` plus `nextTick`
// waits for the route's own DOM patch to land before checking it, on both
// the initial load (`immediate: true`) and every later SPA navigation.
if (typeof document !== 'undefined') {
  const route = useRoute();
  watch(
    () => route.path,
    () => nextTick(markMainLandmark),
    { immediate: true, flush: 'post' },
  );
}
</script>

<template>
  <DefaultTheme.Layout />
</template>
