<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { toast } from 'svelte-sonner';
	import { invalidateAll } from '$app/navigation';
	import { ShieldAlert } from '@lucide/svelte';
	import { t, tn, type Locale } from '$lib/i18n/index.js';

	type Failure = { id: number; identifier: string; failedAt: string; kind: string };
	type Policy = { maxAttempts: number; windowMinutes: number; lockoutMinutes: number };
	type PageData = { policy: Policy; failures: Failure[]; isAdmin?: boolean };

	let { data }: { data: PageData } = $props();
	const isAdmin = $derived(data.isAdmin ?? true);
	const locale = $derived($page.data.locale as Locale);
	let unlockTarget = $state('');
	let busy = $state(false);

	function relative(iso: string): string {
		const ts = new Date(iso).getTime();
		const diff = Math.max(0, Date.now() - ts);
		const s = Math.floor(diff / 1000);
		if (s < 60) return t(locale, 'settings.security.age-seconds', { n: s });
		if (s < 3600) return t(locale, 'settings.security.age-minutes', { n: Math.floor(s / 60) });
		if (s < 86400) return t(locale, 'settings.security.age-hours', { n: Math.floor(s / 3600) });
		return t(locale, 'settings.security.age-days', { n: Math.floor(s / 86400) });
	}

	async function unlock() {
		const name = unlockTarget.trim();
		if (!name) {
			toast.error(t(locale, 'settings.security.unlock.error-empty'));
			return;
		}
		busy = true;
		try {
			const res = await fetch('/api/auth/unlock', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username: name }),
			});
			if (res.ok) {
				const body = (await res.json()) as { cleared: number };
				toast.success(
					tn(locale, 'settings.security.unlock.success', body.cleared, { name }),
				);
				unlockTarget = '';
				await invalidateAll();
			} else if (res.status === 403) {
				toast.error(t(locale, 'settings.security.unlock.error-admin-required'));
			} else {
				toast.error(t(locale, 'settings.security.unlock.error-failed'), { description: await res.text() });
			}
		} finally {
			busy = false;
		}
	}
</script>

<Seo
	title={t(locale, 'settings.security.seo-title')}
	description={t(locale, 'settings.security.seo-description')}
/>

<PageHeader
	title={t(locale, 'settings.security.title')}
	description={t(locale, 'settings.security.description')}
/>

<div class="grid gap-4">
	<Card.Root>
		<Card.Header>
			<Card.Title>{t(locale, 'settings.security.policy.title')}</Card.Title>
			<Card.Description>
				{t(locale, 'settings.security.policy.description-lead')}
				{tn(locale, 'settings.security.policy.attempts', data.policy.maxAttempts)}
				{t(locale, 'settings.security.policy.description-within')}
				{tn(locale, 'settings.security.policy.minutes', data.policy.windowMinutes)};
				{t(locale, 'settings.security.policy.description-then')}
				{tn(locale, 'settings.security.policy.minutes', data.policy.lockoutMinutes)}.
				{t(locale, 'settings.security.policy.tune-lead')} <code>auth_policy</code>
				{t(locale, 'settings.security.policy.tune-mid')} <code>app_config</code>.
			</Card.Description>
		</Card.Header>
	</Card.Root>

	{#if isAdmin}
		<Card.Root>
			<Card.Header>
				<Card.Title>{t(locale, 'settings.security.unlock.title')}</Card.Title>
				<Card.Description>{t(locale, 'settings.security.unlock.description')}</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input
						type="text"
					placeholder={t(locale, 'settings.security.unlock.username-placeholder')}
						bind:value={unlockTarget}
						disabled={busy}
						class="sm:max-w-xs"
					/>
					<Button onclick={unlock} disabled={busy || unlockTarget.trim().length === 0}>
						{t(locale, 'settings.security.unlock.title')}
					</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>{t(locale, 'settings.security.recent-failures.title')}</Card.Title>
			<Card.Description>{t(locale, 'settings.security.recent-failures.description')}</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.failures.length === 0}
				<Alert.Root>
					<ShieldAlert class="h-4 w-4" />
					<Alert.Title>{t(locale, 'settings.security.recent-failures.empty-title')}</Alert.Title>
					<Alert.Description>
						{t(locale, 'settings.security.recent-failures.empty-description')}
					</Alert.Description>
				</Alert.Root>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>{t(locale, 'settings.security.recent-failures.column-identifier')}</Table.Head>
							<Table.Head>{t(locale, 'settings.security.recent-failures.column-kind')}</Table.Head>
							<Table.Head>{t(locale, 'settings.security.recent-failures.column-when')}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.failures as f (f.id)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{f.identifier}</Table.Cell>
								<Table.Cell>{f.kind}</Table.Cell>
								<Table.Cell class="text-muted-foreground">{relative(f.failedAt)}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
