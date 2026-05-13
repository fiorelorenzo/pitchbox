<!-- Dashboard route: composes the connection, sync, and Reddit token cards. -->
<script lang="ts">
  import ConnectionCard from '../components/ConnectionCard.svelte';
  import SyncCard from '../components/SyncCard.svelte';
  import RedditTokenCard from '../components/RedditTokenCard.svelte';
</script>

<div class="flex flex-col gap-4">
  <ConnectionCard />
  <SyncCard />
  <RedditTokenCard />
</div>
