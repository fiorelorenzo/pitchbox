<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { page } from '$app/stores';
  import {
    Activity,
    ListChecks,
    Bot,
    Puzzle,
    Gauge,
    KeyRound,
    Languages,
    Building2,
    CreditCard,
    Archive,
    ShieldCheck,
    Sparkles,
    ShieldCog,
  } from '@lucide/svelte';
  import { t, type Locale } from '$lib/i18n/index.js';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const locale = $derived($page.data.locale as Locale);

  // Flat rail of twelve (#254 shipped seven; LI-19/#316 added LinkedIn assist;
  // 2026-09-07's companion decisions added Companion, moved to its own
  // top-level /companion sidebar group by LOR-178/179 (see
  // web/src/lib/components/Sidebar.svelte); #506 added Password;
  // #516 added Onboarding; #555 added Billing). General/Browser extension
  // never 403 - their loaders gate their own data set (member sees an
  // "Admin access required" card instead of a thrown error) - so they're
  // always shown. Password and Onboarding are self-service (gated on being
  // signed in / having an org context at all, not an org role -
  // docs/permissions.md) rather than admin-only. Organization needs an org
  // context (auth on); Retention, Security and LinkedIn assist loaders call
  // requireRole(event, 'admin') and do throw, so those
  // stay role-filtered here too. Billing additionally needs `data.isCloud`:
  // self-host has no plan concept at all (shared/src/plans.ts's
  // resolveEntitlements is unlimited there before it ever looks at a
  // plan), so the link does not exist rather than opening onto a page with
  // nothing to show. The server loaders enforce the real rule; this only
  // hides links that would otherwise 403 or land on a dead page.
  //
  // Agent runners, Quota and Retention are edition-gated the same way
  // Billing is, but the other direction (#183): on cloud they describe the
  // whole deployment (binary path, model id, retention policy), not any
  // one tenant, so their loaders narrow the read to `isInstanceAdmin`
  // there and the rail drops all three entries outright - they stay
  // reachable to the instance admin from `/settings/admin` instead. On
  // self-host the org-role gate is unchanged, so they stay in the rail
  // exactly as before.
  const items = $derived(
    [
      {
        href: '/settings/general',
        label: t(locale, 'settings.nav.general'),
        icon: Activity,
        show: true,
      },
      {
        href: '/settings/onboarding',
        label: t(locale, 'settings.nav.onboarding'),
        icon: ListChecks,
        show: true,
      },
      {
        href: '/settings/runners',
        label: t(locale, 'settings.nav.runners'),
        icon: Bot,
        show: !data.isCloud,
      },
      {
        href: '/settings/extension',
        label: t(locale, 'settings.nav.extension'),
        icon: Puzzle,
        show: true,
      },
      {
        href: '/settings/quota',
        label: t(locale, 'settings.nav.quota'),
        icon: Gauge,
        show: !data.isCloud,
      },
      {
        href: '/settings/password',
        label: t(locale, 'settings.nav.password'),
        icon: KeyRound,
        show: data.signedIn,
      },
      {
        href: '/settings/language',
        label: t(locale, 'settings.nav.language'),
        icon: Languages,
        show: data.signedIn,
      },
      {
        href: '/settings/linkedin-assist',
        label: t(locale, 'settings.nav.linkedin-assist'),
        icon: Sparkles,
        show: data.isAdmin,
      },
      {
        href: '/settings/organization',
        label: t(locale, 'settings.nav.organization'),
        icon: Building2,
        show: data.authOn,
      },
      {
        href: '/settings/billing',
        label: t(locale, 'settings.nav.billing'),
        icon: CreditCard,
        show: data.isAdmin && data.isCloud,
      },
      {
        href: '/settings/retention',
        label: t(locale, 'settings.nav.retention'),
        icon: Archive,
        show: data.isAdmin && !data.isCloud,
      },
      {
        href: '/settings/security',
        label: t(locale, 'settings.nav.security'),
        icon: ShieldCheck,
        show: data.isAdmin,
      },
    ].filter((i) => i.show),
  );

  // #412: a tenth entry, kept out of `items` above and rendered as its own
  // group below a divider rather than folded into the organization-scoped
  // list - it belongs to the operator of the deployment, not to any one
  // organization, and gates on `data.isInstanceAdmin` (requireInstanceAdmin)
  // rather than the per-org `isAdmin`/`authOn` flags every item above uses.
  // True with auth off too (self-host operator owns everything), same
  // no-op convention as the org-scoped items.
  const showAdminArea = $derived(data.isInstanceAdmin);

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
    aria-label={t(locale, 'settings.rail.aria-label')}
  >
    <p
      class="hidden px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground md:block"
    >
      {t(locale, 'settings.rail.section-label')}
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
    {#if showAdminArea}
      <div class="my-2 hidden border-t border-border md:block" role="separator"></div>
      <p
        class="hidden px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground md:block"
      >
        {t(locale, 'settings.rail.admin-section-label')}
      </p>
      <a
        href="/settings/admin"
        aria-current={isActive('/settings/admin') ? 'page' : undefined}
        class={`flex flex-none items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
          isActive('/settings/admin')
            ? 'bg-accent font-medium text-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        }`}
      >
        <ShieldCog class="size-4 flex-none" />
        {t(locale, 'settings.nav.admin')}
      </a>
    {/if}
  </nav>
  <div class="min-w-0 flex-1">
    {@render children()}
  </div>
</div>
