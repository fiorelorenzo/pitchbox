<!-- Side panel app shell: header + tabs nav + placeholder panels. -->
<script lang="ts">
  import { t } from '$ext/i18n';
  import Dashboard from './routes/Dashboard.svelte';
  import Activity from './routes/Activity.svelte';
  import Settings from './routes/Settings.svelte';

  let tab = $state<'dashboard' | 'activity' | 'settings'>('dashboard');
</script>

<main class="flex flex-col h-screen bg-background text-foreground">
  <header class="flex items-center gap-2.5 px-4 py-3 border-b border-border">
    <svg
      viewBox="0 0 512 512"
      class="size-6 shrink-0 rounded-md"
      aria-hidden="true"
    >
      <rect width="512" height="512" rx="112" class="fill-foreground" />
      <rect x="168" y="112" width="72" height="288" rx="12" class="fill-background" />
      <circle cx="272" cy="200" r="104" class="fill-background" />
      <circle cx="272" cy="200" r="44" class="fill-foreground" />
    </svg>
    <span class="text-sm font-semibold">{$t('app.name')}</span>
    <span class="text-xs text-muted-foreground">{$t('app.tagline')}</span>
  </header>

  <nav class="flex border-b border-border text-sm">
    <button
      class="px-3 py-2 {tab === 'dashboard' ? 'border-b-2 border-primary' : 'text-muted-foreground'}"
      onclick={() => (tab = 'dashboard')}>{$t('nav.dashboard')}</button
    >
    <button
      class="px-3 py-2 {tab === 'activity' ? 'border-b-2 border-primary' : 'text-muted-foreground'}"
      onclick={() => (tab = 'activity')}>{$t('nav.activity')}</button
    >
    <button
      class="px-3 py-2 {tab === 'settings' ? 'border-b-2 border-primary' : 'text-muted-foreground'}"
      onclick={() => (tab = 'settings')}>{$t('nav.settings')}</button
    >
  </nav>

  <section class="flex-1 overflow-auto p-4">
    {#if tab === 'dashboard'}
      <Dashboard />
    {:else if tab === 'activity'}
      <Activity />
    {:else}
      <Settings />
    {/if}
  </section>
</main>
