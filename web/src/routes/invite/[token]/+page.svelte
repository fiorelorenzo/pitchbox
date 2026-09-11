<script lang="ts">
  import { page } from '$app/stores';
  import { enhance } from '$app/forms';
  import { Button } from '$lib/components/ui/button';
  import PageContainer from '$lib/components/PageContainer.svelte';
  import { t, splitAroundToken, type Locale } from '$lib/i18n/index.js';

  let { data } = $props();
  let busy = $state(false);

  const locale = $derived($page.data.locale as Locale);
</script>

<PageContainer size="narrow" class="text-center">
  {#if data?.ok === false}
    <h1 class="text-xl font-semibold">{t(locale, 'invite.invalid-title')}</h1>
    <p class="mt-2 text-muted-foreground">
      {t(locale, 'invite.invalid-body')}
    </p>
  {:else}
    <h1 class="text-xl font-semibold">{t(locale, 'invite.title')}</h1>
    <p class="mt-2 text-muted-foreground">
      {#if data?.inviter?.username}
        {@const [before, after] = splitAroundToken(locale, 'invite.invited-by-body', 'org', {
          inviter: data.inviter.username,
        })}
        {before}<span class="font-medium text-foreground"
          >{data?.org?.name ?? t(locale, 'invite.default-org')}</span
        >{after}
      {:else}
        {@const [before, after] = splitAroundToken(locale, 'invite.invited-generic-body', 'org')}
        {before}<span class="font-medium text-foreground"
          >{data?.org?.name ?? t(locale, 'invite.default-org')}</span
        >{after}
      {/if}
    </p>
    <form
      method="POST"
      use:enhance={() => {
        busy = true;
        return async ({ update }) => {
          await update();
          busy = false;
        };
      }}
      class="mt-6"
    >
      <Button type="submit" disabled={busy}
        >{busy ? t(locale, 'invite.accepting-button') : t(locale, 'invite.accept-button')}</Button
      >
    </form>
  {/if}
</PageContainer>
