<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Clock, ExternalLink, Mic, RefreshCw, RotateCcw, Upload, X } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { toast } from 'svelte-sonner';
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { relativeTime } from '$lib/utils/time';
	import { TONE_BANNER_CLASS } from '$lib/config/status-badges';

	// Companion -> Voice (LOR-178/LOR-179, docs/design/DECISIONS.md D35),
	// split out of the old three-card settings/companion page.
	//
	// LOR-223: a voice sample now carries a genre (post/comment/reply) and a
	// source (captured passively, imported from a LinkedIn export, or typed
	// by hand), and the derived profile carries a description per genre
	// alongside the pooled one - a post and a comment are different genres
	// of writing, not the same voice at a different length.

	type VoiceSampleGenre = 'post' | 'comment' | 'reply';
	type VoiceSampleSource = 'capture' | 'import' | 'manual';

	type VoiceSample = {
		id: number;
		text: string;
		url: string | null;
		postedAt: string | null;
		excluded: boolean;
		genre: VoiceSampleGenre;
		source: VoiceSampleSource;
		context: string | null;
		capturedAt: string;
	};
	type GenreSummary = { summary: string | null; itemCount: number; measurable: boolean };
	// Mirrors shared/src/assist/voice-profile.ts's EditSignature - a plain,
	// JSON-serializable measurement, not imported directly so this file
	// stays independent of the server-only shared package the way its other
	// local types already do (VoiceProfile/GenreSummary above).
	type EditSignature = {
		pairCount: number;
		measurable: boolean;
		shortensText: boolean;
		dropsClosingSentence: boolean;
		cutsHedges: boolean;
		dropsOpening: boolean;
		stripsEmoji: boolean;
		changesLanguage: boolean;
		bannedPhrases: string[];
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
		evidenceCounts: {
			voiceSamples: number;
			messages: number;
			drafts: number;
			templates: number;
			acceptedSuggestions: number;
		};
		genres: Record<VoiceSampleGenre, GenreSummary>;
		source: 'derived' | 'manual';
		derivedAt: string | null;
		updatedAt: string;
		editSignature: EditSignature;
		editSignatureDescription: string | null;
		editSignatureExcluded: boolean;
	};
	type PageData = { orgId: number; voiceSamples: VoiceSample[]; voiceProfile: VoiceProfile | null };
	type FormResult = {
		toggledSampleId?: number;
		voiceProfile?: VoiceProfile;
		imported?: { inserted: number; byGenre: { post: number; comment: number } };
		error?: string;
		importError?: string;
	} | null;

	let { data, form }: { data: PageData; form: FormResult } = $props();

	const voiceProfile = $derived(form?.voiceProfile ?? data.voiceProfile);
	let voiceProfileSummary = $state(untrack(() => data.voiceProfile?.summary ?? ''));
	let savingVoiceProfile = $state(false);
	let refreshingVoiceProfile = $state(false);
	let resettingVoiceProfile = $state(false);
	let importingVoice = $state(false);
	const includedSampleCount = $derived(data.voiceSamples.filter((s) => !s.excluded).length);

	const GENRE_LABEL: Record<VoiceSampleGenre, string> = {
		post: 'Post',
		comment: 'Comment',
		reply: 'Reply',
	};
	const SOURCE_LABEL: Record<VoiceSampleSource, string> = {
		capture: 'Captured',
		import: 'Imported',
		manual: 'Manual',
	};
	const GENRE_ORDER: VoiceSampleGenre[] = ['post', 'comment', 'reply'];

	$effect(() => {
		if (form?.voiceProfile && !form?.imported) {
			voiceProfileSummary = form.voiceProfile.summary;
			toast.success(
				form.voiceProfile.source === 'manual' ? 'Voice description saved' : 'Voice profile refreshed',
			);
		}
	});

	$effect(() => {
		if (form?.imported) {
			voiceProfileSummary = form.voiceProfile?.summary ?? voiceProfileSummary;
			const { inserted, byGenre } = form.imported;
			toast.success(
				inserted === 0
					? 'Nothing new in that export - already imported'
					: `Imported ${inserted} sample${inserted === 1 ? '' : 's'} (${byGenre.post} post${byGenre.post === 1 ? '' : 's'}, ${byGenre.comment} comment${byGenre.comment === 1 ? '' : 's'})`,
			);
		}
	});

	$effect(() => {
		if (form?.importError) toast.error(form.importError);
	});

	let voiceFormRefs: Record<number, HTMLFormElement> = $state({});
	let togglingSampleId = $state<number | null>(null);
	let importFileInput: HTMLInputElement | undefined = $state();
	let editSignatureFormRef: HTMLFormElement | undefined = $state();
	let togglingEditSignature = $state(false);

	// LOR-247: below MIN_ITEMS_TO_DERIVE (shared/src/assist/voice-profile.ts,
	// currently 3 - the same floor the "need at least 3" line above already
	// hardcodes) the page leads with how to get a real corpus instead of an
	// empty state, since a fresh org has nothing to show yet.
	const corpusBelowFloor = $derived(!voiceProfile || voiceProfile.itemCount < 3);

	// Client-only "come back later" reminder: requesting the LinkedIn
	// archive and uploading it are two different days for anyone who
	// follows this page's own advice, so a plain per-org localStorage flag -
	// the same shape ExtensionDeviceNudgeBanner already uses for its own
	// dismissed-kind key - is enough to greet a returning visitor without a
	// notification system.
	const exportRequestedKey = $derived(`pitchbox.voice_export_requested.${data.orgId}`);
	let exportRequestedAt = $state<string | null>(null);

	$effect(() => {
		const key = exportRequestedKey;
		try {
			exportRequestedAt = localStorage.getItem(key);
		} catch {
			// localStorage may be unavailable (SSR, restricted contexts).
			exportRequestedAt = null;
		}
	});

	function markExportRequested() {
		const now = new Date().toISOString();
		exportRequestedAt = now;
		try {
			localStorage.setItem(exportRequestedKey, now);
		} catch {
			// ignore
		}
	}

	function dismissExportReminder() {
		exportRequestedAt = null;
		try {
			localStorage.removeItem(exportRequestedKey);
		} catch {
			// ignore
		}
	}

	type ImportSummaryRow = {
		genre: 'post' | 'comment';
		label: string;
		onFile: number;
		newCount: number;
		measurable: boolean;
		summary: string | null;
		neededMore: number;
	};
	// The persistent "what this import found" panel - built from the same
	// `form.imported`/`voiceProfile` the toast above already reads, just kept
	// on screen instead of fading with it (the trust-building moment the
	// issue asks for, not a second source of truth).
	const importSummaryRows = $derived.by((): ImportSummaryRow[] => {
		if (!form?.imported || !voiceProfile) return [];
		const { byGenre } = form.imported;
		return (['post', 'comment'] as const).map((genre) => {
			const g = voiceProfile.genres[genre];
			return {
				genre,
				label: GENRE_LABEL[genre],
				onFile: g.itemCount,
				newCount: byGenre[genre],
				measurable: g.measurable,
				summary: g.summary,
				neededMore: Math.max(0, 3 - g.itemCount),
			};
		});
	});
</script>

{#snippet importUploadForm()}
	<form
		method="POST"
		action="?/importVoice"
		enctype="multipart/form-data"
		use:enhance={() => {
			importingVoice = true;
			return async ({ update }) => {
				await update();
				importingVoice = false;
				if (importFileInput) importFileInput.value = '';
			};
		}}
		class="flex flex-wrap items-center gap-2"
	>
		<input
			bind:this={importFileInput}
			type="file"
			name="file"
			accept=".zip,.csv"
			required
			aria-label="LinkedIn export file"
			class="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
		/>
		<Button type="submit" size="sm" disabled={importingVoice}>
			<Upload class="size-4" /> {importingVoice ? 'Importing...' : 'Import'}
		</Button>
	</form>
{/snippet}

<Seo
	title="Companion - Voice"
	description="How the in-page LinkedIn assistant sounds when it writes as you."
/>

<PageContainer size="default">
	<PageHeader
		title="Voice"
		description="How you write, derived from what you have actually written - your voice samples, outbound messages, sent drafts and project templates - rather than a raw list of posts."
	/>
	<Card.Root>
		<Card.Header>
			<Card.Title class="flex items-center gap-2">
				<Upload class="size-4" />
				{corpusBelowFloor ? 'Get your writing sample from LinkedIn' : 'Import from LinkedIn'}
			</Card.Title>
			{#if corpusBelowFloor}
				<Card.Description>
					Nothing here yet to measure your voice from, so every suggestion falls back to a
					generic register instead of yours. Two steps get you a real one.
				</Card.Description>
			{:else}
				<Card.Description>
					Upload the "Shares.csv"/"Comments.csv" from LinkedIn's own "Get a copy of your data"
					export (the zip works too) to fill the corpus with your posts and comments in one step,
					instead of waiting on passive capture. Re-uploading the same export changes nothing - it
					only ever adds what is not already on file.
				</Card.Description>
			{/if}
		</Card.Header>
		<Card.Content class={corpusBelowFloor ? 'flex flex-col gap-5' : undefined}>
			{#if corpusBelowFloor}
				<div class="flex gap-3">
					<div
						class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
					>
						1
					</div>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-medium">Request your data from LinkedIn</p>
						<p class="mt-1 text-xs text-muted-foreground">
							Choose the full data download, not the quicker option limited to specific
							categories - only the full one includes your posts and comments. LinkedIn still
							emails you twice either way: a small "Basic" archive within minutes that never has
							them, then the real one up to 24 hours later. Wait for the second email before
							uploading anything.
						</p>
						<Button
							href="https://www.linkedin.com/mypreferences/d/download-my-data"
							target="_blank"
							rel="noopener"
							variant="outline"
							size="sm"
							class="mt-2"
							onclick={markExportRequested}
						>
							<ExternalLink class="size-4" /> Request your data on LinkedIn
						</Button>
						{#if exportRequestedAt}
							<div
								class="mt-2 flex items-start gap-2 rounded-md border {TONE_BANNER_CLASS.sky} px-3 py-2 text-xs"
							>
								<Clock class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
								<span class="flex-1">
									Requested {relativeTime(exportRequestedAt)}. Come back once the second email
									arrives and upload its archive below.
								</span>
								<button
									type="button"
									onclick={dismissExportReminder}
									aria-label="Dismiss"
									class="shrink-0 rounded p-0.5 text-sky-800/70 hover:bg-sky-500/20 hover:text-sky-900 dark:text-sky-200/70 dark:hover:text-sky-100"
								>
									<X class="size-3.5" aria-hidden="true" />
								</button>
							</div>
						{/if}
					</div>
				</div>
				<div class="flex gap-3">
					<div
						class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
					>
						2
					</div>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-medium">Upload it once it arrives</p>
						<p class="mt-1 text-xs text-muted-foreground">
							Drop the zip exactly as LinkedIn sends it - no need to unzip it or rename anything.
						</p>
						<div class="mt-2">
							{@render importUploadForm()}
						</div>
					</div>
				</div>
			{:else}
				{@render importUploadForm()}
			{/if}
		</Card.Content>
		{#if importSummaryRows.length > 0}
			<Card.Footer class="flex flex-col gap-2 border-t border-border pt-4">
				<p class="text-sm font-medium">What this import found</p>
				<div class="flex flex-col gap-1">
					{#each importSummaryRows as row (row.genre)}
						<p class="text-xs text-muted-foreground">
							<span class="font-medium text-foreground">{row.label}s:</span>
							{row.onFile} on file{row.newCount > 0 ? ` (${row.newCount} new)` : ''} -
							{row.measurable
								? `enough to describe how you write${row.summary ? `: ${row.summary}` : ''}`
								: `${row.neededMore} more needed before this can measure your ${row.label.toLowerCase()}s`}
						</p>
					{/each}
				</div>
			</Card.Footer>
		{/if}
	</Card.Root>

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

					{#if voiceProfile}
						{#each GENRE_ORDER as genre (genre)}
							{@const g = voiceProfile.genres[genre]}
							{#if g.summary}
								<div class="rounded-md border border-border/60 bg-muted/30 p-2 text-xs">
									<span class="font-medium">{GENRE_LABEL[genre]}s:</span>
									<span class="text-muted-foreground">{g.summary}</span>
								</div>
							{/if}
						{/each}
					{/if}

					{#if voiceProfile?.editSignature.measurable}
						<div class="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-2 text-xs">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-medium">What you cut before posting</span>
								<span class="text-muted-foreground">
									Based on {voiceProfile.editSignature.pairCount} edited suggestion{voiceProfile
										.editSignature.pairCount === 1
										? ''
										: 's'}
								</span>
							</div>
							{#if voiceProfile.editSignatureExcluded}
								<Badge variant="outline" class="w-fit">Excluded from prompt</Badge>
							{/if}
							<p class="text-muted-foreground">
								{voiceProfile.editSignatureDescription ?? 'Nothing recurring enough yet to name.'}
							</p>
							{#if voiceProfile.editSignature.bannedPhrases.length > 0}
								<div class="flex flex-wrap gap-1">
									{#each voiceProfile.editSignature.bannedPhrases as phrase (phrase)}
										<Badge variant="outline">{phrase}</Badge>
									{/each}
								</div>
							{/if}
							<form
								method="POST"
								action="?/toggleEditSignature"
								bind:this={editSignatureFormRef}
								use:enhance={() => {
									togglingEditSignature = true;
									return async ({ update }) => {
										await update();
										togglingEditSignature = false;
									};
								}}
								class="contents"
							>
								<input
									type="hidden"
									name="excluded"
									value={(!voiceProfile.editSignatureExcluded).toString()}
								/>
							</form>
							<label class="flex w-fit items-center gap-2 text-xs text-muted-foreground">
								<Checkbox
									checked={voiceProfile.editSignatureExcluded}
									disabled={togglingEditSignature}
									onCheckedChange={() => editSignatureFormRef?.requestSubmit()}
								/>
								Exclude from prompt
							</label>
						</div>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Voice samples</Card.Title>
				<Card.Description>
					Your own posts and comments, captured passively or imported from a LinkedIn export.
					{includedSampleCount} of {data.voiceSamples.length} feed the derived voice beside this -
					excluding a sample keeps it here, it just stops contributing, because a delete would come
					back on the next capture or import.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				{#if data.voiceSamples.length === 0}
					<EmptyState
						icon={Mic}
						title="No voice samples yet"
						description="Captured passively when you browse your own recent activity on LinkedIn with the extension installed, or filled in one step above from a LinkedIn data export."
					/>
				{:else}
					<div class="flex flex-col divide-y divide-border">
						{#each data.voiceSamples as sample (sample.id)}
							<div class="flex items-start justify-between gap-3 py-3">
								<div class="min-w-0 flex-1">
									{#if sample.genre === 'comment' && sample.context}
										<p class="mb-1 truncate text-xs text-muted-foreground">
											{#if sample.context.startsWith('http')}
												Replying to <a href={sample.context} target="_blank" rel="noreferrer" class="underline">{sample.context}</a>
											{:else}
												Replying to: "{sample.context}"
											{/if}
										</p>
									{/if}
									<p class="text-sm whitespace-pre-wrap">{sample.text}</p>
									<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
										<span>{relativeTime(sample.postedAt ?? sample.capturedAt)}</span>
										<Badge variant="outline">{GENRE_LABEL[sample.genre]}</Badge>
										<Badge variant="outline">{SOURCE_LABEL[sample.source]}</Badge>
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
