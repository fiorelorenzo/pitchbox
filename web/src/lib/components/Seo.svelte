<script lang="ts">
	/**
	 * Page-level <head> metadata. Every route should render exactly one <Seo />
	 * at the top of its template so title/description stay consistent.
	 */
	let {
		title,
		description,
		noindex = true,
	}: {
		/** Page title - rendered as `<title>` and joined with the app name. */
		title: string;
		/** One-sentence description for <meta name="description">. */
		description: string;
		/**
		 * Self-hosted outreach dashboards are not for public crawlers; default to
		 * noindex. Set `false` on pages you actually want Google to pick up.
		 */
		noindex?: boolean;
	} = $props();

	const APP_NAME = 'Pitchbox';
	const fullTitle = $derived(`${title} · ${APP_NAME}`);
</script>

<svelte:head>
	<title>{fullTitle}</title>
	<meta name="description" content={description} />
	{#if noindex}
		<meta name="robots" content="noindex, nofollow" />
	{/if}
</svelte:head>
