<!-- Settings tab: composes appearance, language, sync, data, about cards. -->
<script lang="ts">
  import AppearanceCard from '../components/AppearanceCard.svelte';
  import LanguageCard from '../components/LanguageCard.svelte';
  import SyncSettingsCard from '../components/SyncSettingsCard.svelte';
  import LinkedInAccessCard from '../components/LinkedInAccessCard.svelte';
  import DataCard from '../components/DataCard.svelte';
  import AboutCard from '../components/AboutCard.svelte';
</script>

<div class="flex flex-col gap-4">
  <AppearanceCard />
  <LanguageCard />
  <SyncSettingsCard />
  <LinkedInAccessCard />
  <DataCard />
  <AboutCard />
</div>
