<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Button } from '$lib/components/ui/button';
	import { Info, TriangleAlert, RadioTower } from '@lucide/svelte';
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { toast } from 'svelte-sonner';
	import { fly } from 'svelte/transition';
	import { untrack } from 'svelte';
	import { ASSIST_TONE_NOTES_MAX, type AssistTone } from '@pitchbox/shared/assist/tone';
	import { t, type Locale } from '$lib/i18n/index.js';

	const locale = $derived($page.data.locale as Locale);

	// One line each, in the order they escalate away from the default: what the
	// room is doing, then the fixed registers, then the operator's own words.
	// The copy is the whole feature from where the operator sits - the prompt
	// instruction behind each option lives in shared/src/assist/suggest-prompt.ts.
	const toneOptions = $derived<Array<{ value: AssistTone; label: string; hint: string }>>([
		{
			value: 'match-room',
			label: t(locale, 'settings.linkedin-assist.tone.option-match-room-label'),
			hint: t(locale, 'settings.linkedin-assist.tone.option-match-room-hint'),
		},
		{
			value: 'professional',
			label: t(locale, 'settings.linkedin-assist.tone.option-professional-label'),
			hint: t(locale, 'settings.linkedin-assist.tone.option-professional-hint'),
		},
		{
			value: 'plain',
			label: t(locale, 'settings.linkedin-assist.tone.option-plain-label'),
			hint: t(locale, 'settings.linkedin-assist.tone.option-plain-hint'),
		},
		{
			value: 'warm',
			label: t(locale, 'settings.linkedin-assist.tone.option-warm-label'),
			hint: t(locale, 'settings.linkedin-assist.tone.option-warm-hint'),
		},
		{
			value: 'technical',
			label: t(locale, 'settings.linkedin-assist.tone.option-technical-label'),
			hint: t(locale, 'settings.linkedin-assist.tone.option-technical-hint'),
		},
		{
			value: 'custom',
			label: t(locale, 'settings.linkedin-assist.tone.option-custom-label'),
			hint: t(locale, 'settings.linkedin-assist.tone.option-custom-hint'),
		},
	]);
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
		if (s.tone === 'custom' && !s.toneNotes.trim()) {
			toast.error(t(locale, 'settings.linkedin-assist.error-tone-required'));
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
				toast.success(t(locale, 'settings.linkedin-assist.success-saved'));
			} else if (res.status === 403) {
				toast.error(t(locale, 'settings.linkedin-assist.error-admin-required'));
			} else {
				toast.error(t(locale, 'settings.linkedin-assist.error-save-failed'), {
					description: await res.text(),
				});
			}
		} finally {
			saving = false;
		}
	}
</script>

<Seo
	title={t(locale, 'settings.linkedin-assist.seo-title')}
	description={t(locale, 'settings.linkedin-assist.seo-description')}
/>

<PageHeader
	title={t(locale, 'settings.linkedin-assist.title')}
	description={t(locale, 'settings.linkedin-assist.description')}
/>

	{#if s.killSwitch}
		<Alert.Root variant="destructive" class="mb-4">
			<TriangleAlert class="size-4" />
			<Alert.Title>{t(locale, 'settings.linkedin-assist.kill-switch-banner-title')}</Alert.Title>
			<Alert.Description>
				{t(locale, 'settings.linkedin-assist.kill-switch-banner-description')}
			</Alert.Description>
		</Alert.Root>
	{/if}

<div class="flex flex-col gap-4">
		<Card.Root>
			<Card.Header>
				<Card.Title>{t(locale, 'settings.linkedin-assist.assist.title')}</Card.Title>
				<Card.Description>
					{t(locale, 'settings.linkedin-assist.assist.description')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<label class="flex items-center gap-2 text-sm">
					<Checkbox checked={s.enabled} onCheckedChange={(v) => (s.enabled = !!v)} />
					{t(locale, 'settings.linkedin-assist.assist.enabled-label')}
				</label>
				<label class="flex items-center gap-2 text-sm">
					<Checkbox
						checked={s.collectorEnabled}
						onCheckedChange={(v) => (s.collectorEnabled = !!v)}
					/>
					{t(locale, 'settings.linkedin-assist.assist.collector-enabled-label')}
				</label>
				<div class="grid gap-1.5">
					<span class="text-sm font-medium"
						>{t(locale, 'settings.linkedin-assist.assist.project-label')}</span
					>
					<SelectField
						value={s.projectId ?? undefined}
						onValueChange={(v) => (s.projectId = v as number)}
						options={projectOptions}
						placeholder={t(locale, 'settings.linkedin-assist.assist.project-placeholder')}
						fullWidth
					/>
					<p class="text-xs text-muted-foreground">
						{t(locale, 'settings.linkedin-assist.assist.project-description')}
					</p>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>{t(locale, 'settings.linkedin-assist.tone.title')}</Card.Title>
				<Card.Description>
					{t(locale, 'settings.linkedin-assist.tone.description')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div class="grid gap-1.5">
					<span class="text-sm font-medium">{t(locale, 'settings.linkedin-assist.tone.register-label')}</span>
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
						<label class="text-sm font-medium" for="toneNotes"
							>{t(locale, 'settings.linkedin-assist.tone.custom-label')}</label
						>
						<Input
							id="toneNotes"
							maxlength={ASSIST_TONE_NOTES_MAX}
							placeholder={t(locale, 'settings.linkedin-assist.tone.custom-placeholder')}
							value={s.toneNotes}
							oninput={(e) => (s.toneNotes = e.currentTarget.value)}
						/>
						<p class="text-xs text-muted-foreground">
							{t(locale, 'settings.linkedin-assist.tone.custom-description', {
								max: ASSIST_TONE_NOTES_MAX,
							})}
						</p>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>{t(locale, 'settings.linkedin-assist.caps.title')}</Card.Title>
				<Card.Description>
					{t(locale, 'settings.linkedin-assist.caps.description')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 sm:grid-cols-2">
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="dailyCommentCap"
						>{t(locale, 'settings.linkedin-assist.caps.comments-label')}</label
					>
					<Input
						id="dailyCommentCap"
						type="number"
						min={0}
						max={data.ceilings.comment}
						value={s.dailyCommentCap}
						oninput={(e) => (s.dailyCommentCap = Number(e.currentTarget.value))}
					/>
					<p class="text-xs text-muted-foreground">
						{t(locale, 'settings.linkedin-assist.caps.ceiling', { n: data.ceilings.comment })}
					</p>
				</div>
				<div class="grid gap-1.5">
					<label class="text-sm font-medium" for="dailyPostCap"
						>{t(locale, 'settings.linkedin-assist.caps.posts-label')}</label
					>
					<Input
						id="dailyPostCap"
						type="number"
						min={0}
						max={data.ceilings.post}
						value={s.dailyPostCap}
						oninput={(e) => (s.dailyPostCap = Number(e.currentTarget.value))}
					/>
					<p class="text-xs text-muted-foreground">
						{t(locale, 'settings.linkedin-assist.caps.ceiling', { n: data.ceilings.post })}
					</p>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root class="border-destructive/40">
			<Card.Header>
				<Card.Title>{t(locale, 'settings.linkedin-assist.kill-switch.title')}</Card.Title>
				<Card.Description>
					{t(locale, 'settings.linkedin-assist.kill-switch.description')}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<label class="flex items-center gap-2 text-sm">
					<Checkbox checked={s.killSwitch} onCheckedChange={(v) => (s.killSwitch = !!v)} />
					{t(locale, 'settings.linkedin-assist.kill-switch.engaged-label')}
				</label>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"
					><RadioTower class="size-4" />
					{t(locale, 'settings.linkedin-assist.selector-health.title')}</Card.Title
				>
				<Card.Description>
					{t(locale, 'settings.linkedin-assist.selector-health.description')}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Alert.Root>
					<Info class="size-4" />
					<Alert.Title>{t(locale, 'settings.linkedin-assist.selector-health.empty-title')}</Alert.Title>
					<Alert.Description>
						{t(locale, 'settings.linkedin-assist.selector-health.empty-description')}
					</Alert.Description>
				</Alert.Root>
			</Card.Content>
		</Card.Root>
</div>

{#if dirty}
	<div
		class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg"
		transition:fly={{ y: 20, duration: 150 }}
	>
		<span class="text-sm">{t(locale, 'settings.linkedin-assist.unsaved-changes')}</span>
		<Button variant="outline" size="sm" onclick={discard}
			>{t(locale, 'settings.linkedin-assist.discard')}</Button
		>
		<Button size="sm" onclick={save} disabled={saving}
			>{t(locale, 'settings.linkedin-assist.save')}</Button
		>
	</div>
{/if}
