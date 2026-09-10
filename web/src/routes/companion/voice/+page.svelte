<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Mic, RefreshCw, RotateCcw } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { toast } from 'svelte-sonner';
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { relativeTime } from '$lib/utils/time';

	// Companion -> Voice (LOR-178/LOR-179, docs/design/DECISIONS.md D35),
	// split out of the old three-card settings/companion page.

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
	type PageData = { voiceSamples: VoiceSample[]; voiceProfile: VoiceProfile | null };
	type FormResult = {
		toggledSampleId?: number;
		voiceProfile?: VoiceProfile;
		error?: string;
	} | null;

	let { data, form }: { data: PageData; form: FormResult } = $props();

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
</script>

<Seo
	title="Companion - Voice"
	description="How the in-page LinkedIn assistant sounds when it writes as you."
/>

<PageContainer size="default">
	<PageHeader
		title="Voice"
		description="How you write, derived from what you have actually written - your voice samples, outbound messages, sent drafts and project templates - rather than a raw list of posts."
	/>

	<div class="grid items-start gap-4 xl:grid-cols-2">
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
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Voice samples</Card.Title>
				<Card.Description>
					Your own recent posts, captured passively. {includedSampleCount} of {data.voiceSamples
						.length} feed the derived voice beside this - excluding a sample keeps it here, it just
					stops contributing, because a delete would come back on the next capture.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
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
	</div>
</PageContainer>
