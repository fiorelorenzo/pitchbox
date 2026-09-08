<!-- Settings keeps only what an operator changes (#402). Connection,
     permission and health state all moved to home (#399/#400): a switch is
     something you set once, a state is something you read, and mixing the two
     is what made the operator hunt across two tabs to answer one question.
     Order: what you see, what you read it in, how often it syncs, then the
     two you touch once (destructive actions, and what version this is). -->
<script lang="ts">
  import AppearanceCard from '../components/AppearanceCard.svelte';
  import LanguageCard from '../components/LanguageCard.svelte';
  import SyncSettingsCard from '../components/SyncSettingsCard.svelte';
  import DataCard from '../components/DataCard.svelte';
  import AboutCard from '../components/AboutCard.svelte';
</script>

<div class="flex flex-col gap-4">
  <AppearanceCard />
  <LanguageCard />
  <SyncSettingsCard />
  <DataCard />
  <AboutCard />
</div>
