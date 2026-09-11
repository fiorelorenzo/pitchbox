<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Info, Activity } from '@lucide/svelte';
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import SettingsAppearanceCard from '$lib/components/SettingsAppearanceCard.svelte';
	import SettingsLanguageCard from '$lib/components/settings/SettingsLanguageCard.svelte';
	import { daemonStatus } from '$lib/stores/daemon';
	import { PULSE_DOT_CLASS } from '$lib/config/status-badges';
	import { t, type Locale } from '$lib/i18n/index.js';

	const locale = $derived($page.data.locale as Locale);
	// 2026-09-12: gates the folded-in language card the same way
	// /settings/language's own loader used to gate the whole page - signed
	// in is the whole requirement, no org role. Nobody signed in (auth
	// off) means there is no account to save a locale preference for, so
	// the card is skipped rather than shown with nowhere to write; the
	// rest of the page renders exactly as it does today either way.
	const signedIn = $derived($page.data.signedIn as boolean);

	function formatAge(seconds: number): string {
		if (seconds < 60) return t(locale, 'settings.general.daemon.age-seconds', { n: seconds });
		if (seconds < 3600)
			return t(locale, 'settings.general.daemon.age-minutes', { n: Math.floor(seconds / 60) });
		return t(locale, 'settings.general.daemon.age-hours', { n: Math.floor(seconds / 3600) });
	}
</script>

<Seo
	title={t(locale, 'settings.general.seo-title')}
	description={t(locale, 'settings.general.seo-description')}
/>

<PageHeader
	title={t(locale, 'settings.general.title')}
	description={t(locale, 'settings.general.description')}
/>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<Card.Root size="sm">
			<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
				<Activity class="size-4 shrink-0 text-muted-foreground" />
				<Card.Title class="text-base min-w-0 flex-1 truncate"
					>{t(locale, 'settings.general.daemon.title')}</Card.Title
				>
				{#if $daemonStatus.permitted}
					<StatusBadge
						class="shrink-0"
						domain="daemon-status"
						value={$daemonStatus.loading
							? 'checking'
							: !$daemonStatus.reachable
								? 'unknown'
								: $daemonStatus.alive
									? 'online'
									: 'offline'}
					/>
				{/if}
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<p class="text-xs text-muted-foreground">
					{t(locale, 'settings.general.daemon.description')}
				</p>
				{#if !$daemonStatus.permitted}
					<Alert.Root>
						<Info class="size-4" />
						<Alert.Title>{t(locale, 'settings.general.daemon.admin-required-title')}</Alert.Title>
						<Alert.Description>
							{t(locale, 'settings.general.daemon.admin-required-description')}
						</Alert.Description>
					</Alert.Root>
				{:else if !$daemonStatus.reachable && !$daemonStatus.loading}
					<Alert.Root>
						<Info class="size-4" />
						<Alert.Title>{t(locale, 'settings.general.daemon.unavailable-title')}</Alert.Title>
						<Alert.Description>
							{t(locale, 'settings.general.daemon.unavailable-description')}
						</Alert.Description>
					</Alert.Root>
				{:else if $daemonStatus.modules.length === 0 && !$daemonStatus.loading}
					<Alert.Root>
						<Info class="size-4" />
						<Alert.Title>{t(locale, 'settings.general.daemon.not-running-title')}</Alert.Title>
						<Alert.Description>
							{t(locale, 'settings.general.daemon.not-running-description')}
							<code class="text-xs font-mono">pnpm -F daemon dev</code>.
						</Alert.Description>
					</Alert.Root>
				{:else}
					<ul class="flex flex-col gap-2">
						{#each $daemonStatus.modules as m (m.module)}
							<li class="flex items-center gap-2 text-sm">
								<span
									class="size-2 rounded-full shrink-0 {m.alive
										? PULSE_DOT_CLASS.emerald
										: 'bg-muted-foreground/40'}"
								></span>
								<span class="font-mono text-xs">{m.module}</span>
								<span class="text-xs text-muted-foreground ml-auto">
									{formatAge(m.ageSeconds)}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>

	<SettingsAppearanceCard />
	{#if signedIn}
		<SettingsLanguageCard />
	{/if}
</div>
