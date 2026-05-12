<script lang="ts">
	// Placeholder Appearance card. Persists the chosen UI locale in
	// `localStorage` until `app_config.ui_locale` server-side plumbing lands.
	import * as Card from '$lib/components/ui/card';
	import { Languages } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import SelectField from '$lib/components/ui/select-field/select-field.svelte';
	import { LOCALES, locale, setLocale, t, type Locale } from '$lib/i18n';

	const STORAGE_KEY = 'pitchbox.ui_locale';

	const options = [
		{ value: 'en', label: 'English' },
		{ value: 'it', label: 'Italiano' },
	];

	let current = $state<Locale>('en');

	onMount(() => {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored === 'en' || stored === 'it') {
				setLocale(stored);
			}
		} catch {
			// localStorage may be unavailable (SSR, restricted contexts).
		}
		current = $locale;
	});

	function onChange(value: string | undefined) {
		if (!value) return;
		if (!(LOCALES as readonly string[]).includes(value)) return;
		const next = value as Locale;
		current = next;
		setLocale(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// ignore
		}
	}
</script>

<Card.Root size="sm">
	<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
		<Languages class="size-4 shrink-0 text-muted-foreground" />
		<Card.Title class="text-base min-w-0 flex-1 truncate">{$t('settings.appearance.title')}</Card.Title>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		<div class="flex flex-col gap-1.5">
			<label class="text-xs font-medium text-muted-foreground" for="ui-locale">
				{$t('settings.appearance.locale.label')}
			</label>
			<SelectField id="ui-locale" value={current} {options} onValueChange={onChange} />
		</div>
		<p class="text-xs text-muted-foreground">{$t('settings.appearance.locale.help')}</p>
	</Card.Content>
</Card.Root>
