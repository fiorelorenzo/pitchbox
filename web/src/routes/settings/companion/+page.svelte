<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Info, TriangleAlert, Plus, Trash2, UserRound, Mic, FolderGit2 } from '@lucide/svelte';
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
	type PageData = { profile: Persona | null; voiceSamples: VoiceSample[]; maxVoiceSamples: number };
	type FormResult = { profile?: Persona; toggledSampleId?: number; error?: string } | null;

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

	// listVoiceSamples (and this page's loader) return every sample newest
	// first including excluded ones, so this order is exactly the order
	// loadCompanionContext filters and truncates from - the "used" set below
	// is a straight walk of that same list.
	const usedSampleIds = $derived.by(() => {
		const ids = new Set<number>();
		let count = 0;
		for (const s of data.voiceSamples) {
			if (s.excluded) continue;
			if (count >= data.maxVoiceSamples) break;
			ids.add(s.id);
			count++;
		}
		return ids;
	});
	const usedCount = $derived(
		Math.min(data.voiceSamples.filter((s) => !s.excluded).length, data.maxVoiceSamples),
	);

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
					Your own recent posts, captured passively as examples of your voice. {usedCount} of {data
						.voiceSamples.length} are used in prompts (up to {data.maxVoiceSamples}, newest first).
					Excluding a sample keeps it here - it just stays out of the prompt - because a delete would
					come back on the next capture.
				</Card.Description>
			</Card.Header>
			<Card.Content>
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
										{#if usedSampleIds.has(sample.id)}
											<Badge variant="secondary">Used</Badge>
										{:else if sample.excluded}
											<Badge variant="outline">Excluded</Badge>
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
					Public repositories the companion can mention. Public repos only, added by URL with no
					credential - a private repo needs the GitHub App, which doesn't exist yet.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
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
