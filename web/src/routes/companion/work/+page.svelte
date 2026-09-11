<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Info, TriangleAlert, Plus, Trash2, FolderGit2, KeyRound } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { toast } from 'svelte-sonner';
	import { onMount } from 'svelte';
	import { relativeTime } from '$lib/utils/time';
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';

	// Companion -> Work (LOR-178/LOR-179, docs/design/DECISIONS.md D35),
	// split out of the old three-card settings/companion page. The GitHub
	// repos it may cite are read as operator context by the prompt, so they
	// belong to the companion rather than to any one project - moving them
	// there would split one persona across N project pages.

	const locale = $derived($page.data.locale as Locale);
	type GithubSource = {
		id: number;
		owner: string;
		repo: string;
		url: string;
		description: string | null;
		primaryLanguage: string | null;
		fetchedAt: string | null;
		fetchError: string | null;
	};

	let repos = $state<GithubSource[]>([]);
	let loadingRepos = $state(true);
	let reposLoadError = $state(false);
	let newRepoUrl = $state('');
	let addingRepo = $state(false);
	let removingRepoId = $state<number | null>(null);

	async function loadRepos() {
		loadingRepos = true;
		reposLoadError = false;
		try {
			const res = await fetch('/api/settings/github-sources');
			if (!res.ok) {
				reposLoadError = true;
				return;
			}
			const body = (await res.json()) as { sources: GithubSource[] };
			repos = body.sources;
		} catch {
			reposLoadError = true;
		} finally {
			loadingRepos = false;
		}
	}
	onMount(loadRepos);

	async function addRepo(e: Event) {
		e.preventDefault();
		const url = newRepoUrl.trim();
		if (!url) return;
		addingRepo = true;
		try {
			const res = await fetch('/api/settings/github-sources', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url }),
			});
			if (res.ok) {
				newRepoUrl = '';
				toast.success(t(locale, 'companion.work.toast-repo-added'));
				await loadRepos();
			} else if (res.status === 403) {
				toast.error(t(locale, 'companion.work.error-forbidden'));
			} else {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				toast.error(body?.message ?? t(locale, 'companion.work.error-add-repo-failed'));
			}
		} catch {
			toast.error(t(locale, 'companion.work.error-add-repo-failed'));
		} finally {
			addingRepo = false;
		}
	}

	// --- The optional GitHub App (#390) -------------------------------------
	// `configured` is the deployment's own state (does an app exist at all),
	// `installations` is this org's. A self-host with no app is not an error
	// and gets a sentence rather than a warning: public repos by URL keep
	// working exactly as they did.

	type GithubInstallation = {
		id: number;
		installationId: number;
		accountLogin: string;
		accountType: string;
		repositorySelection: string;
		permissions: Record<string, string>;
		updatedAt: string;
	};

	let appConfigured = $state(false);
	let installations = $state<GithubInstallation[]>([]);
	let loadingInstallations = $state(true);
	let disconnectingId = $state<number | null>(null);

	async function loadInstallations() {
		loadingInstallations = true;
		try {
			const res = await fetch('/api/settings/github-installations');
			if (!res.ok) return;
			const body = (await res.json()) as {
				configured: boolean;
				installations: GithubInstallation[];
			};
			appConfigured = body.configured;
			installations = body.installations;
		} catch {
			// Leave the card in its "not configured" shape rather than shouting:
			// nothing here is required for the companion to work.
		} finally {
			loadingInstallations = false;
		}
	}
	onMount(loadInstallations);

	// The install and setup round trip reports back in the query string
	// (web/src/routes/api/integrations/github/setup/+server.ts), so the result
	// of a redirect the operator just came back from is said out loud once.
	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		const result = params.get('github');
		if (!result) return;
		const detail = params.get('detail');
		const messages: Record<string, string> = {
			installed: detail
				? t(locale, 'companion.work.github-connected-detail', { detail })
				: t(locale, 'companion.work.github-connected'),
			requested: t(locale, 'companion.work.github-install-requested'),
			not_configured: t(locale, 'companion.work.github-not-configured'),
			no_state: t(locale, 'companion.work.github-no-state'),
			wrong_org: t(locale, 'companion.work.github-wrong-org'),
			forbidden: t(locale, 'companion.work.github-forbidden'),
			unauthenticated: t(locale, 'companion.work.github-unauthenticated'),
			claimed_by_other_org: t(locale, 'companion.work.github-claimed-by-other-org'),
			unverified: detail
				? t(locale, 'companion.work.github-unverified-detail', { detail })
				: t(locale, 'companion.work.github-unverified'),
			bad_request: t(locale, 'companion.work.github-bad-request'),
		};
		if (result === 'installed' || result === 'requested') {
			toast.success(messages[result]);
		} else {
			toast.error(messages[result] ?? t(locale, 'companion.work.github-install-incomplete'));
		}
		// Strip the params so a refresh does not repeat the toast.
		window.history.replaceState({}, '', window.location.pathname);
	});

	async function disconnectInstallation(id: number) {
		if (disconnectingId) return;
		disconnectingId = id;
		try {
			const res = await fetch(`/api/settings/github-installations/${id}`, { method: 'DELETE' });
			if (res.ok) {
				const body = (await res.json()) as { uninstalled: boolean; reason: string | null };
				if (body.uninstalled) {
					toast.success(t(locale, 'companion.work.toast-github-disconnected'));
				} else {
					// The row is gone either way, so the org has already stopped
					// using the credential. Say what is left to do by hand.
					toast.warning(t(locale, 'companion.work.warn-uninstall-unconfirmed'));
				}
				await Promise.all([loadInstallations(), loadRepos()]);
			} else if (res.status === 403) {
				toast.error(t(locale, 'companion.work.error-forbidden'));
			} else {
				toast.error(t(locale, 'companion.work.error-disconnect-failed'));
			}
		} finally {
			disconnectingId = null;
		}
	}

	async function removeRepo(id: number) {
		if (removingRepoId) return;
		removingRepoId = id;
		try {
			const res = await fetch(`/api/settings/github-sources/${id}`, { method: 'DELETE' });
			if (res.ok) {
				toast.success(t(locale, 'companion.work.toast-repo-removed'));
				await loadRepos();
			} else if (res.status === 403) {
				toast.error(t(locale, 'companion.work.error-forbidden'));
			} else {
				toast.error(t(locale, 'companion.work.error-remove-repo-failed'));
			}
		} finally {
			removingRepoId = null;
		}
	}
</script>

<Seo
	title={t(locale, 'companion.work.seo-title')}
	description={t(locale, 'companion.work.seo-description')}
/>

<PageContainer size="default">
	<PageHeader
		title={t(locale, 'companion.work.title')}
		description={t(locale, 'companion.work.description')}
	/>

	<div class="grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><FolderGit2 class="size-4" /> {t(locale, 'companion.work.shipped-card-title')}</Card.Title>
				<Card.Description>
					{t(locale, 'companion.work.shipped-card-description')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<form onsubmit={addRepo} class="flex gap-2">
					<Input
						bind:value={newRepoUrl}
						placeholder="https://github.com/owner/repo"
						aria-label={t(locale, 'companion.work.repo-url-aria')}
						class="flex-1"
					/>
					<Button type="submit" disabled={addingRepo || !newRepoUrl.trim()}>
						<Plus class="size-4" /> {t(locale, 'companion.work.add-button')}
					</Button>
				</form>

				{#if loadingRepos}
					<p class="text-xs text-muted-foreground">{t(locale, 'companion.work.loading-repos')}</p>
				{:else if reposLoadError}
					<Alert.Root variant="destructive">
						<TriangleAlert class="size-4" />
						<Alert.Title>{t(locale, 'companion.work.load-error-title')}</Alert.Title>
					</Alert.Root>
				{:else if repos.length === 0}
					<EmptyState
						icon={FolderGit2}
						title={t(locale, 'companion.work.empty-repos-title')}
						description={t(locale, 'companion.work.empty-repos-description')}
						size="sm"
					/>
				{:else}
					<div class="flex flex-col divide-y divide-border">
						{#each repos as source (source.id)}
							<div class="flex items-start justify-between gap-3 py-3">
								<div class="min-w-0 flex-1">
									<a
										href={source.url}
										target="_blank"
										rel="noopener noreferrer"
										class="text-sm font-medium text-foreground hover:underline"
									>
										{source.owner}/{source.repo}
									</a>
									{#if source.description}
										<p class="mt-0.5 text-xs text-muted-foreground">{source.description}</p>
									{/if}
									<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
										{#if source.primaryLanguage}
											<Badge variant="outline">{source.primaryLanguage}</Badge>
										{/if}
									<span>
										{source.fetchedAt
											? t(locale, 'companion.work.fetched-label', { when: relativeTime(source.fetchedAt) })
											: t(locale, 'companion.work.not-fetched-yet')}
									</span>
									</div>
									{#if source.fetchError}
										<Alert.Root variant="destructive" class="mt-2">
											<Info class="size-4" />
											<Alert.Description>{source.fetchError}</Alert.Description>
										</Alert.Root>
									{/if}
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={removingRepoId === source.id}
									onclick={() => removeRepo(source.id)}
								aria-label={t(locale, 'companion.work.remove-repo-aria')}
								>
									<Trash2 class="size-4" />
								</Button>
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<!-- The GitHub App (#390). Its own card beside the list on purpose:
		     whether a private URL will work at all is decided here. -->
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"
					><KeyRound class="size-4" /> {t(locale, 'companion.work.github-app-card-title')}</Card.Title
				>
				<Card.Description>
					{t(locale, 'companion.work.github-app-card-description')}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if !loadingInstallations}
					{#if !appConfigured}
						<p class="text-xs text-muted-foreground">
							{t(locale, 'companion.work.not-configured-note')}
						</p>
					{:else if installations.length === 0}
						<div class="flex flex-col items-start gap-3">
							<p class="text-xs text-muted-foreground">
								{t(locale, 'companion.work.connect-app-note')}
							</p>
							<Button href="/api/integrations/github/install" data-sveltekit-reload>
								<KeyRound class="size-4" /> {t(locale, 'companion.work.connect-github-button')}
							</Button>
						</div>
					{:else}
						<div class="flex flex-col gap-3">
							{#each installations as install (install.id)}
								<div class="flex flex-wrap items-center justify-between gap-3">
									<div class="min-w-0">
										<p class="text-sm font-medium text-foreground">
											{install.accountLogin}
										<Badge variant="outline" class="ml-1 align-middle">
											{install.repositorySelection === 'all'
												? t(locale, 'companion.work.repo-selection-all')
												: t(locale, 'companion.work.repo-selection-selected')}
										</Badge>
									</p>
										<p class="mt-0.5 text-xs text-muted-foreground">
										{Object.entries(install.permissions)
											.map(([name, level]) => t(locale, 'companion.work.permission-entry', { name, level }))
											.join(', ') || t(locale, 'companion.work.no-permissions-reported')}
										</p>
									</div>
									<div class="flex items-center gap-2">
										<Button
											href="/api/integrations/github/install"
											variant="outline"
											size="sm"
											data-sveltekit-reload
										>
										{t(locale, 'companion.work.change-repos-button')}
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											disabled={disconnectingId === install.id}
											onclick={() => disconnectInstallation(install.id)}
										>
										{t(locale, 'companion.work.disconnect-button')}
										</Button>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</PageContainer>
