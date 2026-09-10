<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Plus, Trash2, UserRound } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { toast } from 'svelte-sonner';
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { relativeTime } from '$lib/utils/time';

	// Companion -> Persona (LOR-178/LOR-179, docs/design/DECISIONS.md D35):
	// the landing page of its own top-level sidebar group, split out of the
	// old three-card settings/companion page so the fields Lorenzo corrects
	// most - handle, display name, headline, about, with the provenance
	// badge - are the first thing open without scrolling.

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
	type PageData = { profile: Persona | null };
	type FormResult = { profile?: Persona; error?: string } | null;

	let { data, form }: { data: PageData; form: FormResult } = $props();

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
</script>

<Seo
	title="Companion - Persona"
	description="Who the in-page LinkedIn assistant writes as: handle, display name, headline, about and experience."
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
	</div>
</PageContainer>
