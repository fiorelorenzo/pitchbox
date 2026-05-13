<!-- Side panel app shell: header + tabs nav + placeholder panels. -->
<script lang="ts">
  import { t } from '$ext/i18n';

  let tab = $state<'dashboard' | 'activity' | 'settings'>('dashboard');
</script>

<main class="flex flex-col h-screen bg-background text-foreground">
  <header class="flex items-center gap-2 px-4 py-3 border-b border-border">
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
      <p class="text-sm text-muted-foreground">Dashboard placeholder</p>
    {:else if tab === 'activity'}
      <p class="text-sm text-muted-foreground">Activity placeholder</p>
    {:else}
      <p class="text-sm text-muted-foreground">Settings placeholder</p>
    {/if}
  </section>
</main>
