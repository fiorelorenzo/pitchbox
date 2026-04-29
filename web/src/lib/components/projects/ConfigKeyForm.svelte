<script lang="ts">
  import ProductPitchForm from './forms/ProductPitchForm.svelte';
  import ProductUrlForm from './forms/ProductUrlForm.svelte';
  import ProductDefaultAccountRoleForm from './forms/ProductDefaultAccountRoleForm.svelte';
  import ProductSelfPromoPolicyForm from './forms/ProductSelfPromoPolicyForm.svelte';
  import ProductDisclosurePolicyForm from './forms/ProductDisclosurePolicyForm.svelte';
  import OfferForm from './forms/OfferForm.svelte';
  import VoiceDmRulesForm from './forms/VoiceDmRulesForm.svelte';
  import VoicePostRulesForm from './forms/VoicePostRulesForm.svelte';
  import TopicAnglesForm from './forms/TopicAnglesForm.svelte';
  import RawJsonConfigForm from './RawJsonConfigForm.svelte';

  type Props = {
    keyName: string;
    value: unknown;
    onChange: (v: unknown) => void;
    forceRaw?: boolean;
  };
  let { keyName, value, onChange, forceRaw = false }: Props = $props();
</script>

{#if forceRaw}
  <RawJsonConfigForm {value} {onChange} />
{:else if keyName === 'product.pitch'}
  <ProductPitchForm value={value as { text: string }} {onChange} />
{:else if keyName === 'product.url'}
  <ProductUrlForm value={value as { url: string }} {onChange} />
{:else if keyName === 'product.defaultAccountRole'}
  <ProductDefaultAccountRoleForm value={value as { role: 'personal' | 'brand' }} {onChange} />
{:else if keyName === 'product.selfPromoPolicy'}
  <ProductSelfPromoPolicyForm value={value as { default: 'never' | 'allowed' | 'on_request' }} {onChange} />
{:else if keyName === 'product.disclosurePolicy'}
  <ProductDisclosurePolicyForm value={value as { default: string }} {onChange} />
{:else if keyName === 'offer'}
  <OfferForm value={value as { name: string; cta: string; composeSubject: string; url?: string }} {onChange} />
{:else if keyName === 'voice.dm_rules'}
  <VoiceDmRulesForm value={value as { hardBans: string[]; dos: string[]; disclosure: string; examples: string[] }} {onChange} />
{:else if keyName === 'voice.post_rules'}
  <VoicePostRulesForm value={value as { hardBans: string[]; dos: string[]; lengthRange: [number, number] }} {onChange} />
{:else if keyName === 'topicAngles'}
  <TopicAnglesForm value={value as string[]} {onChange} />
{:else}
  <RawJsonConfigForm {value} {onChange} />
{/if}
