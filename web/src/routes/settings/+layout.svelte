<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { page } from '$app/stores';
  import { Activity, Bot, Puzzle, Gauge, Building2, Archive, ShieldCheck, Sparkles } from '@lucide/svelte';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // Flat rail of eight (#254 shipped seven; LI-19/#316 added LinkedIn assist).
  // Status/Agent runners/Browser extension/Quota never 403 - each loader
  // gates its own data set (member sees an "Admin access required" card
  // instead of a thrown error) - so they're always shown, same as General
  // used to be. Organization needs an org context (auth on); Retention,
  // Security and LinkedIn assist loaders call requireRole(event, 'admin')
  // and do throw, so those stay role-filtered here too. The server loaders
  // enforce the real rule; this only hides links that would otherwise 403.
  const items = $derived(
    [
      { href: '/settings/status', label: 'Status', icon: Activity, show: true },
      { href: '/settings/runners', label: 'Agent runners', icon: Bot, show: true },
      { href: '/settings/extension', label: 'Browser extension', icon: Puzzle, show: true },
      { href: '/settings/quota', label: 'Quota', icon: Gauge, show: true },
      {
        href: '/settings/linkedin-assist',
        label: 'LinkedIn assist',
        icon: Sparkles,
        show: data.isAdmin,
      },
      { href: '/settings/organization', label: 'Organization', icon: Building2, show: data.authOn },
      { href: '/settings/retention', label: 'Retention', icon: Archive, show: data.isAdmin },
      { href: '/settings/security', label: 'Security', icon: ShieldCheck, show: data.isAdmin },
    ].filter((i) => i.show),
  );

  function isActive(href: string): boolean {
    return $page.url.pathname.startsWith(href);
  }
</script>

<div class="flex flex-col gap-6 md:flex-row md:gap-8">
  <!--
    Below md this is a horizontal strip. It must WRAP rather than scroll: seven
    entries do not fit in 390px, and a scrolling strip hid four of them behind an
    edge with no affordance, which is the same silent-clip defect #244 fixed for
    tables. Wrapping keeps every section reachable without a swipe.
  -->
  <nav
    class="flex flex-wrap gap-1 border-b border-border pb-2 md:w-48 md:flex-none md:flex-col md:flex-nowrap md:border-b-0 md:pb-0"
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
        aria-current={isActive(item.href) ? 'page' : undefined}
        class={`flex flex-none items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
          isActive(item.href)
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
