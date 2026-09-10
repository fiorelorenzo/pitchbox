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

	// Companion -> Work (LOR-178/LOR-179, docs/design/DECISIONS.md D35),
	// split out of the old three-card settings/companion page. The GitHub
	// repos it may cite are read as operator context by the prompt, so they
	// belong to the companion rather than to any one project - moving them
	// there would split one persona across N project pages.

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
				toast.success('Repository added');
				await loadRepos();
			} else if (res.status === 403) {
				toast.error('You need admin access for that');
			} else {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				toast.error(body?.message ?? 'Could not add that repository');
			}
		} catch {
			toast.error('Could not add that repository');
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
			installed: `GitHub connected${detail ? ` for ${detail}` : ''}`,
			requested: 'Install requested. An owner of that account has to approve it.',
			not_configured: 'This deployment has no GitHub App configured.',
			no_state: 'Start the install from this page, so it lands on the right organization.',
			wrong_org: 'That install was started for a different organization.',
			forbidden: 'You need admin access to connect GitHub.',
			unauthenticated: 'Sign in again and retry the install.',
			claimed_by_other_org: 'That GitHub account is already connected to another organization.',
			unverified: `GitHub would not confirm that installation${detail ? `: ${detail}` : ''}`,
			bad_request: 'GitHub sent back an install with no installation id.',
		};
		if (result === 'installed' || result === 'requested') {
			toast.success(messages[result]);
		} else {
			toast.error(messages[result] ?? 'The GitHub install did not complete');
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
					toast.success('GitHub disconnected and the app uninstalled');
				} else {
					// The row is gone either way, so the org has already stopped
					// using the credential. Say what is left to do by hand.
					toast.warning(
						'Disconnected here, but GitHub did not confirm the uninstall. Remove it from the account settings on GitHub.',
					);
				}
				await Promise.all([loadInstallations(), loadRepos()]);
			} else if (res.status === 403) {
				toast.error('You need admin access for that');
			} else {
				toast.error('Could not disconnect that installation');
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
				toast.success('Repository removed');
				await loadRepos();
			} else if (res.status === 403) {
				toast.error('You need admin access for that');
			} else {
				toast.error('Could not remove that repository');
			}
		} finally {
			removingRepoId = null;
		}
	}
</script>

<Seo
	title="Companion - Work"
	description="Repositories the in-page LinkedIn assistant can mention when it writes about what you've built."
/>

<PageContainer size="default">
	<PageHeader
		title="Companion"
		description="Repositories the companion can mention. A public repo needs nothing but its URL; a private one needs the GitHub App below."
	/>

	<div class="max-w-2xl flex flex-col gap-4">
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><FolderGit2 class="size-4" /> What you have shipped</Card.Title>
				<Card.Description>
					Repositories the companion can mention. A public repo needs nothing but its URL. A
					private one is only readable once this organization connects the GitHub App below, and
					only for the repositories the account selects.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<!-- The GitHub App (#390). Above the add form on purpose: whether a
				     private URL will work at all is decided here. -->
				{#if !loadingInstallations}
					<div class="rounded-md border border-border bg-muted/30 p-4">
						{#if !appConfigured}
							<p class="text-xs text-muted-foreground">
								No GitHub App is configured on this deployment, so repositories are read
								anonymously: public ones only, and GitHub allows 60 requests an hour per
								address. That is the intended self-host setup and needs no credential.
							</p>
						{:else if installations.length === 0}
							<div class="flex flex-wrap items-center justify-between gap-3">
								<p class="text-xs text-muted-foreground">
									Connect the GitHub App to read private repositories. You choose which
									repositories it can see, it asks for read access to code and metadata and
									nothing else, and you can disconnect it here at any time.
								</p>
								<Button href="/api/integrations/github/install" data-sveltekit-reload>
									<KeyRound class="size-4" /> Connect GitHub
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
														? 'all repositories'
														: 'selected repositories'}
												</Badge>
											</p>
											<p class="mt-0.5 text-xs text-muted-foreground">
												{Object.entries(install.permissions)
													.map(([name, level]) => `${name}: ${level}`)
													.join(', ') || 'no permissions reported'}
											</p>
										</div>
										<div class="flex items-center gap-2">
											<Button
												href="/api/integrations/github/install"
												variant="outline"
												size="sm"
												data-sveltekit-reload
											>
												Change repositories
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												disabled={disconnectingId === install.id}
												onclick={() => disconnectInstallation(install.id)}
											>
												Disconnect
											</Button>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<form onsubmit={addRepo} class="flex gap-2">
					<Input
						bind:value={newRepoUrl}
						placeholder="https://github.com/owner/repo"
						aria-label="Repository URL"
						class="flex-1"
					/>
					<Button type="submit" disabled={addingRepo || !newRepoUrl.trim()}>
						<Plus class="size-4" /> Add
					</Button>
				</form>

				{#if loadingRepos}
					<p class="text-xs text-muted-foreground">Loading repositories...</p>
				{:else if reposLoadError}
					<Alert.Root variant="destructive">
						<TriangleAlert class="size-4" />
						<Alert.Title>Could not load repositories</Alert.Title>
					</Alert.Root>
				{:else if repos.length === 0}
					<EmptyState
						icon={FolderGit2}
						title="No repositories yet"
						description="Add a public GitHub repo URL above so the companion can talk about what you've built."
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
												? `fetched ${relativeTime(source.fetchedAt)}`
												: 'not fetched yet'}
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
									aria-label="Remove repository"
								>
									<Trash2 class="size-4" />
								</Button>
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</PageContainer>
