<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Button } from '$lib/components/ui/button';
	import { Info, TriangleAlert, RadioTower } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import { toast } from 'svelte-sonner';
	import { fly } from 'svelte/transition';
	import { untrack } from 'svelte';
	import { ASSIST_TONE_NOTES_MAX, type AssistTone } from '@pitchbox/shared/assist/tone';

	// One line each, in the order they escalate away from the default: what the
	// room is doing, then the fixed registers, then the operator's own words.
	// The copy is the whole feature from where the operator sits - the prompt
	// instruction behind each option lives in shared/src/assist/suggest-prompt.ts.
	const toneOptions: Array<{ value: AssistTone; label: string; hint: string }> = [
		{
			value: 'match-room',
			label: 'Match the room',
			hint: "Mixes the post's own register with your voice. The default, and what a person actually does."
		},
		{
			value: 'professional',
			label: 'Professional',
			hint: 'Full sentences, no slang, and no corporate filler either.'
		},
		{ value: 'plain', label: 'Plain', hint: 'Short sentences and ordinary words.' },
		{ value: 'warm', label: 'Warm', hint: 'Addresses the author as a person, without exclamation marks.' },
		{
			value: 'technical',
			label: 'Technical',
			hint: 'Specific about mechanisms, numbers and tradeoffs.'
		},
		{ value: 'custom', label: 'In my own words', hint: 'Describe the tone yourself, below.' }
	];
	const toneHint = $derived(toneOptions.find((o) => o.value === s.tone)?.hint ?? '');

	type Settings = {
		enabled: boolean;
		projectId: number | null;
		collectorEnabled: boolean;
		dailyCommentCap: number;
		dailyPostCap: number;
		killSwitch: boolean;
		tone: AssistTone;
		toneNotes: string;
	};
	type PageData = {
		settings: Settings;
		projects: Array<{ id: number; name: string }>;
		ceilings: { comment: number; post: number };
	};

	let { data }: { data: PageData } = $props();

	// Dirty-tracking state - untrack to silence state_referenced_locally.
	let initial = $state(untrack(() => structuredClone(data.settings)));
	let s = $state(untrack(() => structuredClone(data.settings)));
	const dirty = $derived(JSON.stringify(s) !== JSON.stringify(initial));
	let saving = $state(false);

	// The stored project id can point at a project that has since been
	// deleted (app_config holds no foreign key); if it's not among the org's
	// current projects, show the picker unset rather than a dead selection.
	const projectOptions = $derived(data.projects.map((p) => ({ value: p.id, label: p.name })));
	$effect(() => {
		if (s.projectId != null && !data.projects.some((p) => p.id === s.projectId)) {
			s.projectId = null;
		}
	});

	function discard() {
		s = structuredClone(initial);
	}

	async function save() {
		if (s.enabled && s.projectId == null) {
			toast.error('Bind a project before enabling assist');
			return;
		}
		if (s.tone === 'custom' && !s.toneNotes.trim()) {
			toast.error('Describe the tone you want, or pick one of the named options');
			return;
		}
		saving = true;
		try {
			const res = await fetch('/api/settings/linkedin-assist', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(s),
			});
			if (res.ok) {
				initial = structuredClone(s);
				toast.success('LinkedIn assist settings saved');
			} else if (res.status === 403) {
				toast.error('You need admin access for that');
			} else {
				toast.error('Save failed', { description: await res.text() });
			}
		} finally {
			saving = false;
		}
	}
</script>

<Seo
	title="Settings - LinkedIn assist"
	description="On/off, bound project, daily caps and the kill switch for the in-page LinkedIn assistant."
/>

<PageContainer size="default">
	<PageHeader
		title="LinkedIn assist"
		description="Controls the in-page assistant on linkedin.com: who it writes as, how much it may send, and a kill switch that applies immediately."
	/>

	{#if s.killSwitch}
		<Alert.Root variant="destructive" class="mb-4">
			<TriangleAlert class="size-4" />
			<Alert.Title>Kill switch is on</Alert.Title>
			<Alert.Description>
				Suggestions and observation collection are stopped for every device in this
				organization, regardless of the settings below.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="max-w-2xl flex flex-col gap-4">
		<Card.Root>
			<Card.Header>
				<Card.Title>Assist</Card.Title>
				<Card.Description>
					Off by default. A suggestion is written as a project's voice, so a project must be
					bound before assist can be enabled.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<label class="flex items-center gap-2 text-sm">
					<Checkbox checked={s.enabled} onCheckedChange={(v) => (s.enabled = !!v)} />
					Assist enabled
				</label>
				<div class="grid gap-1.5">
					<span class="text-sm font-medium">Writes as project</span>
					<SelectField
						value={s.projectId ?? undefined}
						onValueChange={(v) => (s.projectId = v as number)}
						options={projectOptions}
						placeholder="No project bound"
						fullWidth
					/>
				</div>
				<label class="flex items-center gap-2 text-sm">
					<Checkbox
						checked={s.collectorEnabled}
						onCheckedChange={(v) => (s.collectorEnabled = !!v)}
					/>
					Observation collector enabled
				</label>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Tone</Card.Title>
				<Card.Description>
					How a suggestion should sound. The house style outranks every option here, so none of
					them can ask for the typography Pitchbox never emits, and a tone sent by the extension
					is ignored: this page is where it is decided.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div class="grid gap-1.5">
					<span class="text-sm font-medium">Register</span>
					<SelectField
						value={s.tone}
						onValueChange={(v) => (s.tone = v as AssistTone)}
						options={toneOptions.map((o) => ({ value: o.value, label: o.label }))}
						fullWidth
					/>
					<p class="text-xs text-muted-foreground">{toneHint}</p>
				</div>
				{#if s.tone === 'custom'}
					<div class="grid gap-1.5">
						<label class="text-sm font-medium" for="toneNotes">In your own words</label>
						<Input
							id="toneNotes"
							maxlength={ASSIST_TONE_NOTES_MAX}
							placeholder="Direct, a bit dry, no enthusiasm I would not say out loud"
							value={s.toneNotes}
							oninput={(e) => (s.toneNotes = e.currentTarget.value)}
						/>
						<p class="text-xs text-muted-foreground">
							Goes into the prompt as you wrote it, up to {ASSIST_TONE_NOTES_MAX} characters.
						</p>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Daily caps</Card.Title>
				<Card.Description>
					Can be lowered, never raised past the code ceiling: LinkedIn's velocity monitoring
					treats a high-volume account as a bot regardless of how carefully it was written.
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 sm:grid-cols-2">
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="dailyCommentCap">Comments / day</label>
					<Input
						id="dailyCommentCap"
						type="number"
						min={0}
						max={data.ceilings.comment}
						value={s.dailyCommentCap}
						oninput={(e) => (s.dailyCommentCap = Number(e.currentTarget.value))}
					/>
					<p class="text-xs text-muted-foreground">Ceiling: {data.ceilings.comment} / day</p>
				</div>
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="dailyPostCap">Posts / day</label>
					<Input
						id="dailyPostCap"
						type="number"
						min={0}
						max={data.ceilings.post}
						value={s.dailyPostCap}
						oninput={(e) => (s.dailyPostCap = Number(e.currentTarget.value))}
					/>
					<p class="text-xs text-muted-foreground">Ceiling: {data.ceilings.post} / day</p>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root class="border-destructive/40">
			<Card.Header>
				<Card.Title>Kill switch</Card.Title>
				<Card.Description>
					Stops both collection and suggestion immediately, on every device, without waiting for
					the next alarm. Separate from turning assist off: use this for "something is wrong right
					now", not for routine pausing.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<label class="flex items-center gap-2 text-sm">
					<Checkbox checked={s.killSwitch} onCheckedChange={(v) => (s.killSwitch = !!v)} />
					Kill switch engaged
				</label>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><RadioTower class="size-4" /> Selector health</Card.Title>
				<Card.Description>
					Whether the extension can still find LinkedIn's feed, composer and submit controls
					(LI-6, #303). The failure mode this guards against is silent breakage: an assistant
					that quietly stops finding posts looks identical to a quiet week.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Alert.Root>
					<Info class="size-4" />
					<Alert.Title>No reports yet</Alert.Title>
					<Alert.Description>
						Nothing has been reported by an installed extension. This card will populate once
						the collector (#302) ships and starts reporting selector health here.
					</Alert.Description>
				</Alert.Root>
			</Card.Content>
		</Card.Root>
	</div>
</PageContainer>

{#if dirty}
	<div
		class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg"
		transition:fly={{ y: 20, duration: 150 }}
	>
		<span class="text-sm">You have unsaved changes</span>
		<Button variant="outline" size="sm" onclick={discard}>Discard</Button>
		<Button size="sm" onclick={save} disabled={saving}>Save</Button>
	</div>
{/if}
