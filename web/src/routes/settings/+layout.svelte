<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { page } from '$app/stores';
  import { SlidersHorizontal, Building2, Archive, ShieldCheck } from '@lucide/svelte';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // Rail sections. General is always shown; Organization needs an org context
  // (auth on); Retention and Security are admin-only. The server loaders enforce
  // the same rule, so this only hides links that would otherwise 403.
  const items = $derived(
    [
      { href: '/settings', label: 'General', icon: SlidersHorizontal, exact: true, show: true },
      {
        href: '/settings/organization',
        label: 'Organization',
        icon: Building2,
        exact: false,
        show: data.authOn,
      },
      {
        href: '/settings/retention',
        label: 'Retention',
        icon: Archive,
        exact: false,
        show: data.isAdmin,
      },
      {
        href: '/settings/security',
        label: 'Security',
        icon: ShieldCheck,
        exact: false,
        show: data.isAdmin,
      },
    ].filter((i) => i.show),
  );

  function isActive(href: string, exact: boolean): boolean {
    const path = $page.url.pathname;
    return exact ? path === href : path.startsWith(href);
  }
</script>

<div class="flex flex-col gap-6 md:flex-row md:gap-8">
  <nav
    class="flex gap-1 overflow-x-auto border-b border-border pb-2 md:w-48 md:flex-none md:flex-col md:border-b-0 md:pb-0"
    aria-label="Settings sections"
  >
    <p
      class="hidden px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground md:block"
    >
      Settings
    </p>
    {#each items as item (item.href)}
      {@const Icon = item.icon}
      <a
        href={item.href}
        aria-current={isActive(item.href, item.exact) ? 'page' : undefined}
        class={`flex flex-none items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
          isActive(item.href, item.exact)
            ? 'bg-accent font-medium text-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        }`}
      >
        <Icon class="size-4 flex-none" />
        {item.label}
      </a>
    {/each}
  </nav>
  <div class="min-w-0 flex-1">
    {@render children()}
  </div>
</div>
