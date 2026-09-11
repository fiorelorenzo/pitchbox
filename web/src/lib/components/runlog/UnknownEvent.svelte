<script lang="ts">
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';

	let { data }: { data: { type: string; raw: string } } = $props();

	const locale = $derived($page.data.locale as Locale);
</script>

<span class="text-[10px] text-muted-foreground/60 font-mono"
	>{t(locale, 'runlog.event-prefix', { type: data.type })}</span
>
