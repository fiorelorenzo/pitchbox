<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Info, TriangleAlert, Plus, Trash2, UserRound, Mic, FolderGit2, RefreshCw, RotateCcw, KeyRound } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { toast } from 'svelte-sonner';
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import { untrack } from 'svelte';
	import { relativeTime } from '$lib/utils/time';

	// Settings -> Companion (2026-09-07 decisions, docs/platforms/linkedin.md
	// "What the companion knows"). Three independent knowledge sources feed
	// the in-page assistant's prompt: the operator's own persona and voice
	// (captured passively by the extension, or edited here), and the public
	// GitHub repos it may cite (Github's own API under
	// /api/settings/github-sources, fetched client-side like
	// ExtensionDevices does for paired devices).

	const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

	type Experience = { title?: string; company?: string; period?: string; summary?: string };
	type Persona = {
		handle: string | null;
		displayName: string | null;
		headline: string | null;
		about: string | null;
		experiences: Experience[];
		notes: string | null;
		source: string;
		capturedAt: string | null;
	};
	type VoiceSample = {
		id: number;
		text: string;
		url: string | null;
		postedAt: string | null;
		excluded: boolean;
		capturedAt: string;
	};
	type VoiceProfile = {
		summary: string;
		traits: string[];
		openings: string[];
		closings: string[];
		commonWords: string[];
		wordsPerSentence: number;
		itemCount: number;
		wordCount: number;
		evidenceCounts: { voiceSamples: number; messages: number; drafts: number; templates: number };
		source: 'derived' | 'manual';
		derivedAt: string | null;
		updatedAt: string;
	};
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
	type PageData = {
		profile: Persona | null;
		voiceSamples: VoiceSample[];
		voiceProfile: VoiceProfile | null;
	};
	type FormResult = {
		profile?: Persona;
		toggledSampleId?: number;
		voiceProfile?: VoiceProfile;
		error?: string;
	} | null;

	let { data, form }: { data: PageData; form: FormResult } = $props();

	// --- Who you are -----------------------------------------------------

	let handle = $state(untrack(() => data.profile?.handle ?? ''));
	let displayName = $state(untrack(() => data.profile?.displayName ?? ''));
	let headline = $state(untrack(() => data.profile?.headline ?? ''));
	let about = $state(untrack(() => data.profile?.about ?? ''));
	let notes = $state(untrack(() => data.profile?.notes ?? ''));
	let experiences = $state<Experience[]>(
		untrack(() => (data.profile?.experiences ?? []).map((e) => ({ ...e }))),
	);
	let savingProfile = $state(false);

	const capturedAt = $derived(data.profile?.capturedAt ? new Date(data.profile.capturedAt) : null);
	const staleCapture = $derived(
		capturedAt != null && Date.now() - capturedAt.getTime() > NINETY_DAYS_MS,
	);

	function addExperience() {
		experiences = [...experiences, {}];
	}
	function removeExperience(index: number) {
		experiences = experiences.filter((_, i) => i !== index);
	}

	$effect(() => {
		if (form?.profile) {
			toast.success('Persona saved');
			handle = form.profile.handle ?? '';
			displayName = form.profile.displayName ?? '';
			headline = form.profile.headline ?? '';
			about = form.profile.about ?? '';
			notes = form.profile.notes ?? '';
			experiences = form.profile.experiences.map((e) => ({ ...e }));
		} else if (form?.error) {
			toast.error(form.error);
		}
	});

	// --- How you write -----------------------------------------------------

	const voiceProfile = $derived(form?.voiceProfile ?? data.voiceProfile);
	let voiceProfileSummary = $state(untrack(() => data.voiceProfile?.summary ?? ''));
	let savingVoiceProfile = $state(false);
	let refreshingVoiceProfile = $state(false);
	let resettingVoiceProfile = $state(false);
	const includedSampleCount = $derived(data.voiceSamples.filter((s) => !s.excluded).length);

	$effect(() => {
		if (form?.voiceProfile) {
			voiceProfileSummary = form.voiceProfile.summary;
			toast.success(
				form.voiceProfile.source === 'manual' ? 'Voice description saved' : 'Voice profile refreshed',
			);
		}
	});

	let voiceFormRefs: Record<number, HTMLFormElement> = $state({});
	let togglingSampleId = $state<number | null>(null);

	// --- What you have shipped ----------------------------------------------

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
	title="Settings - Companion"
	description="What the in-page LinkedIn assistant knows: your persona, your writing voice, and the repos you've shipped."
/>

<PageContainer size="default">
	<PageHeader
		title="Companion"
		description="What the in-page LinkedIn assistant knows about you, so a suggestion sounds like something you'd actually say. Nothing here is sent anywhere until a suggestion is requested."
	/>

	<div class="max-w-2xl flex flex-col gap-4">
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><UserRound class="size-4" /> Who you are</Card.Title>
				<Card.Description>
					Captured once when you open your own LinkedIn profile with the extension installed, and
					editable here afterward. A saved edit is kept as-is: the next capture will not overwrite
					it.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if !data.profile}
					<EmptyState
						icon={UserRound}
						title="No persona captured yet"
						description="Open your own LinkedIn profile once with the extension installed - that's what fills this in."
					/>
				{:else}
					{#if data.profile.capturedAt}
						<div class="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<Badge variant={data.profile.source === 'manual' ? 'secondary' : 'outline'}>
								{data.profile.source === 'manual' ? 'Manually edited' : 'From LinkedIn capture'}
							</Badge>
							<span>Captured {relativeTime(data.profile.capturedAt)}</span>
							{#if staleCapture}
								<Badge variant="destructive">Stale, over 90 days old</Badge>
							{/if}
						</div>
						{#if data.profile.source === 'manual'}
							<!-- LOR-180: saveOperatorProfile refuses to overwrite a manual row, so a
							     recapture after this point changes nothing on the LinkedIn side either -
							     without this line that reads as a broken recapture rather than the
							     protection working as designed. -->
							<p class="mb-4 text-xs text-muted-foreground">
								A LinkedIn recapture will not change this: it stays as you last edited it.
							</p>
						{/if}
					{/if}
					<form
						method="POST"
						action="?/saveProfile"
						use:enhance={({ formData }) => {
							formData.set('experiences', JSON.stringify(experiences));
							savingProfile = true;
							return async ({ update }) => {
								await update();
								savingProfile = false;
							};
						}}
						class="flex flex-col gap-4"
					>
						<div class="grid gap-4 sm:grid-cols-2">
							<div class="grid gap-1.5">
								<label class="text-sm font-medium" for="handle">LinkedIn handle</label>
								<Input id="handle" name="handle" bind:value={handle} placeholder="jane-doe" />
							</div>
							<div class="grid gap-1.5">
								<label class="text-sm font-medium" for="displayName">Display name</label>
								<Input id="displayName" name="displayName" bind:value={displayName} />
							</div>
						</div>
						<div class="grid gap-1.5">
							<label class="text-sm font-medium" for="headline">Headline</label>
							<Input id="headline" name="headline" bind:value={headline} />
						</div>
						<div class="grid gap-1.5">
							<label class="text-sm font-medium" for="about">About</label>
							<Textarea id="about" name="about" bind:value={about} rows={4} />
						</div>

						<div class="grid gap-2">
							<span class="text-sm font-medium">Experience</span>
							{#each experiences as experience, i (i)}
								<div class="flex flex-col gap-2 rounded-md border border-border p-3">
									<div class="flex items-start justify-between gap-2">
										<div class="grid flex-1 gap-2 sm:grid-cols-3">
											<Input bind:value={experience.title} placeholder="Title" aria-label="Title" />
											<Input
												bind:value={experience.company}
												placeholder="Company"
												aria-label="Company"
											/>
											<Input bind:value={experience.period} placeholder="Period" aria-label="Period" />
										</div>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											onclick={() => removeExperience(i)}
											aria-label="Remove experience"
										>
											<Trash2 class="size-4" />
										</Button>
									</div>
									<Textarea
										bind:value={experience.summary}
										placeholder="Summary"
										aria-label="Summary"
										rows={2}
									/>
								</div>
							{/each}
							<div>
								<Button type="button" variant="outline" size="sm" onclick={addExperience}>
									<Plus class="size-4" /> Add experience
								</Button>
							</div>
						</div>

						<div class="grid gap-1.5">
							<label class="text-sm font-medium" for="notes">How you want to sound</label>
							<Textarea
								id="notes"
								name="notes"
								bind:value={notes}
								rows={3}
								placeholder="Direct, no corporate hedging, short sentences..."
							/>
							<p class="text-xs text-muted-foreground">
								Free text, never captured from LinkedIn - this is only what you type here.
							</p>
						</div>

						<div>
							<Button type="submit" disabled={savingProfile}>Save persona</Button>
						</div>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><Mic class="size-4" /> How you write</Card.Title>
				<Card.Description>
					A description of your writing habits, derived from what you have actually written - your
					voice samples, outbound messages, sent drafts and project templates - rather than a raw
					list of posts. Reviewable and editable below.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div class="flex flex-col gap-3 rounded-md border border-border p-3">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="text-sm font-medium">Derived voice</span>
						{#if voiceProfile}
							<Badge variant={voiceProfile.source === 'manual' ? 'secondary' : 'outline'}>
								{voiceProfile.source === 'manual' ? 'Manually edited' : 'Derived'}
							</Badge>
						{/if}
					</div>

					{#if !voiceProfile?.summary.trim() && voiceProfile?.source !== 'manual'}
						<p class="text-sm text-muted-foreground">
							Not enough of your own writing on file yet to say anything honest about how you write{#if voiceProfile}
								&nbsp;({voiceProfile.itemCount} piece{voiceProfile.itemCount === 1 ? '' : 's'} so far, need at least 3)
							{/if}. This looks at your voice samples, outbound messages, sent drafts and project
							templates.
						</p>
					{/if}

					<form
						method="POST"
						action="?/saveVoiceProfile"
						use:enhance={() => {
							savingVoiceProfile = true;
							return async ({ update }) => {
								await update();
								savingVoiceProfile = false;
							};
						}}
						class="flex flex-col gap-2"
					>
						<Textarea
							name="summary"
							bind:value={voiceProfileSummary}
							rows={4}
							placeholder="Derived automatically once you have enough voice samples, messages, drafts or templates on file..."
						/>
						<div>
							<Button type="submit" size="sm" disabled={savingVoiceProfile}>Save</Button>
						</div>
					</form>

					<div class="flex flex-wrap items-center gap-2">
						<form
							method="POST"
							action="?/refreshVoiceProfile"
							use:enhance={() => {
								refreshingVoiceProfile = true;
								return async ({ update }) => {
									await update();
									refreshingVoiceProfile = false;
								};
							}}
						>
							<Button type="submit" variant="outline" size="sm" disabled={refreshingVoiceProfile}>
								<RefreshCw class="size-4" /> Refresh now
							</Button>
						</form>
						{#if voiceProfile?.source === 'manual'}
							<form
								method="POST"
								action="?/resetVoiceProfile"
								use:enhance={() => {
									resettingVoiceProfile = true;
									return async ({ update }) => {
										await update();
										resettingVoiceProfile = false;
									};
								}}
							>
								<Button type="submit" variant="ghost" size="sm" disabled={resettingVoiceProfile}>
									<RotateCcw class="size-4" /> Reset to derived
								</Button>
							</form>
						{/if}
					</div>

					{#if voiceProfile && voiceProfile.itemCount > 0}
						<p class="text-xs text-muted-foreground">
							Derived from {voiceProfile.evidenceCounts.voiceSamples} voice sample{voiceProfile
								.evidenceCounts.voiceSamples === 1
								? ''
								: 's'}, {voiceProfile.evidenceCounts.messages} message{voiceProfile.evidenceCounts
								.messages === 1
								? ''
								: 's'}, {voiceProfile.evidenceCounts.drafts} sent draft{voiceProfile.evidenceCounts
								.drafts === 1
								? ''
								: 's'} and {voiceProfile.evidenceCounts.templates} template{voiceProfile
								.evidenceCounts.templates === 1
								? ''
								: 's'}{#if voiceProfile.derivedAt}
								&nbsp;- last derived {relativeTime(voiceProfile.derivedAt)}
							{/if}
						</p>
					{/if}
				</div>

				<div class="flex flex-col gap-1">
					<span class="text-sm font-medium">Voice samples</span>
					<p class="text-xs text-muted-foreground">
						Your own recent posts, captured passively. {includedSampleCount} of {data.voiceSamples
							.length} feed the derived voice above. Excluding a sample keeps it here - it just stops
						contributing - because a delete would come back on the next capture.
					</p>
				</div>
				{#if data.voiceSamples.length === 0}
					<EmptyState
						icon={Mic}
						title="No voice samples yet"
						description="Captured passively when you browse your own recent activity on LinkedIn with the extension installed."
					/>
				{:else}
					<div class="flex flex-col divide-y divide-border">
						{#each data.voiceSamples as sample (sample.id)}
							<div class="flex items-start justify-between gap-3 py-3">
								<div class="min-w-0 flex-1">
									<p class="text-sm whitespace-pre-wrap">{sample.text}</p>
									<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
										<span>{relativeTime(sample.postedAt ?? sample.capturedAt)}</span>
										{#if sample.excluded}
											<Badge variant="outline">Excluded</Badge>
										{:else}
											<Badge variant="secondary">Included</Badge>
										{/if}
									</div>
								</div>
								<form
									method="POST"
									action="?/toggleVoiceSample"
									bind:this={voiceFormRefs[sample.id]}
									use:enhance={() => {
										togglingSampleId = sample.id;
										return async ({ update }) => {
											await update();
											togglingSampleId = null;
										};
									}}
									class="contents"
								>
									<input type="hidden" name="sampleId" value={sample.id} />
									<input type="hidden" name="excluded" value={(!sample.excluded).toString()} />
								</form>
								<label class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
									<Checkbox
										checked={sample.excluded}
										disabled={togglingSampleId === sample.id}
										onCheckedChange={() => voiceFormRefs[sample.id]?.requestSubmit()}
									/>
									Exclude
								</label>
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

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
