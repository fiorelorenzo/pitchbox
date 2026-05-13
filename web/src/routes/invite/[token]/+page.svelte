<script lang="ts">
  let { data } = $props();
</script>

<div class="mx-auto max-w-md p-8 text-center">
  {#if data?.ok === false}
    <h1 class="text-xl font-semibold">Invite invalid or expired</h1>
    <p class="mt-2 text-muted-foreground">
      Ask the organization admin to issue a new invite link.
    </p>
  {:else}
    <p>Accepting invite…</p>
  {/if}
</div>
