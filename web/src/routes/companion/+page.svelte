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
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';

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

	const locale = $derived($page.data.locale as Locale);

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
			toast.success(t(locale, 'companion.persona.toast-saved'));
			handle = form.profile.handle ?? '';
			displayName = form.profile.displayName ?? '';
			headline = form.profile.headline ?? '';
			about = form.profile.about ?? '';
			notes = form.profile.notes ?? '';
			experiences = form.profile.experiences.map((e) => ({ ...e }));
		} else if (form?.error) {
			toast.error(t(locale, 'companion.persona.error-save-failed'));
		}
	});
</script>

<Seo
	title={t(locale, 'companion.persona.seo-title')}
	description={t(locale, 'companion.persona.seo-description')}
/>

<PageContainer size="default">
	<PageHeader
		title={t(locale, 'companion.persona.title')}
		description={t(locale, 'companion.persona.description')}
	/>

	{#if !data.profile}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><UserRound class="size-4" /> {t(locale, 'companion.persona.card-title')}</Card.Title>
				<Card.Description>
					{t(locale, 'companion.persona.card-description')}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<EmptyState
					icon={UserRound}
					title={t(locale, 'companion.persona.empty-title')}
					description={t(locale, 'companion.persona.empty-description')}
				/>
			</Card.Content>
		</Card.Root>
	{:else}
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
			class="grid items-start gap-4 xl:grid-cols-2"
		>
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2"
						><UserRound class="size-4" /> {t(locale, 'companion.persona.card-title')}</Card.Title
					>
					<Card.Description>
						{t(locale, 'companion.persona.card-description')}
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-col gap-4">
					{#if data.profile.capturedAt}
						<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<Badge variant={data.profile.source === 'manual' ? 'secondary' : 'outline'}>
								{data.profile.source === 'manual'
									? t(locale, 'companion.persona.source-manual')
									: t(locale, 'companion.persona.source-captured')}
							</Badge>
							<span>{t(locale, 'companion.persona.captured-label', { when: relativeTime(data.profile.capturedAt) })}</span>
							{#if staleCapture}
								<Badge variant="destructive">{t(locale, 'companion.persona.stale-badge')}</Badge>
							{/if}
						</div>
						{#if data.profile.source === 'manual'}
							<!-- LOR-180: saveOperatorProfile refuses to overwrite a manual row, so a
							     recapture after this point changes nothing on the LinkedIn side either -
							     without this line that reads as a broken recapture rather than the
							     protection working as designed. -->
							<p class="text-xs text-muted-foreground">
								{t(locale, 'companion.persona.manual-note')}
							</p>
						{/if}
					{/if}
					<div class="grid gap-4 sm:grid-cols-2">
						<div class="grid gap-1.5">
							<label class="text-sm font-medium" for="handle">{t(locale, 'companion.persona.handle-label')}</label>
							<Input id="handle" name="handle" bind:value={handle} placeholder={t(locale, 'companion.persona.handle-placeholder')} />
						</div>
						<div class="grid gap-1.5">
							<label class="text-sm font-medium" for="displayName">{t(locale, 'companion.persona.display-name-label')}</label>
							<Input id="displayName" name="displayName" bind:value={displayName} />
						</div>
					</div>
					<div class="grid gap-1.5">
						<label class="text-sm font-medium" for="headline">{t(locale, 'companion.persona.headline-label')}</label>
						<Input id="headline" name="headline" bind:value={headline} />
					</div>
					<div class="grid gap-1.5">
						<label class="text-sm font-medium" for="about">{t(locale, 'companion.persona.about-label')}</label>
						<Textarea id="about" name="about" bind:value={about} rows={4} />
					</div>
					<div class="grid gap-1.5">
						<label class="text-sm font-medium" for="notes">{t(locale, 'companion.persona.notes-label')}</label>
						<Textarea
							id="notes"
							name="notes"
							bind:value={notes}
							rows={3}
							placeholder={t(locale, 'companion.persona.notes-placeholder')}
						/>
						<p class="text-xs text-muted-foreground">
							{t(locale, 'companion.persona.notes-hint')}
						</p>
					</div>
					<div>
						<Button type="submit" disabled={savingProfile}>{t(locale, 'companion.persona.save-button')}</Button>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>{t(locale, 'companion.persona.experience-title')}</Card.Title>
					<Card.Description>
						{t(locale, 'companion.persona.experience-description')}
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-col gap-2">
					{#each experiences as experience, i (i)}
						<div class="flex flex-col gap-2 rounded-md border border-border p-3">
							<div class="flex items-start justify-between gap-2">
								<div class="grid flex-1 gap-2 sm:grid-cols-3">
									<Input bind:value={experience.title} placeholder={t(locale, 'companion.persona.experience-field.title')} aria-label={t(locale, 'companion.persona.experience-field.title')} />
									<Input bind:value={experience.company} placeholder={t(locale, 'companion.persona.experience-field.company')} aria-label={t(locale, 'companion.persona.experience-field.company')} />
									<Input bind:value={experience.period} placeholder={t(locale, 'companion.persona.experience-field.period')} aria-label={t(locale, 'companion.persona.experience-field.period')} />
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									onclick={() => removeExperience(i)}
								aria-label={t(locale, 'companion.persona.remove-experience-aria')}
								>
									<Trash2 class="size-4" />
								</Button>
							</div>
							<Textarea
								bind:value={experience.summary}
								placeholder={t(locale, 'companion.persona.experience-field.summary')}
								aria-label={t(locale, 'companion.persona.experience-field.summary')}
								rows={2}
							/>
						</div>
					{/each}
					<div>
						<Button type="button" variant="outline" size="sm" onclick={addExperience}>
							<Plus class="size-4" /> {t(locale, 'companion.persona.add-experience-button')}
						</Button>
					</div>
				</Card.Content>
			</Card.Root>
		</form>
	{/if}
</PageContainer>
