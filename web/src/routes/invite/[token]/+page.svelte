<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '$lib/components/ui/button';

  let { data } = $props();
  let busy = $state(false);
</script>

<div class="mx-auto max-w-md p-8 text-center">
  {#if data?.ok === false}
    <h1 class="text-xl font-semibold">Invite invalid or expired</h1>
    <p class="mt-2 text-muted-foreground">
      Ask the organization admin to issue a new invite link.
    </p>
  {:else}
    <h1 class="text-xl font-semibold">You're invited</h1>
    <p class="mt-2 text-muted-foreground">
      {#if data?.inviter?.username}
        {data.inviter.username} invited you to join
      {:else}
        You have been invited to join
      {/if}
      <span class="font-medium text-foreground">{data?.org?.name ?? 'this organization'}</span>.
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
      <Button type="submit" disabled={busy}>{busy ? 'Accepting…' : 'Accept invite'}</Button>
    </form>
  {/if}
</div>
