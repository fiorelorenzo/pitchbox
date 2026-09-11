<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { t, type Locale } from '$lib/i18n/index.js';
	import type { PageData } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { toast } from 'svelte-sonner';
	import {
		SCENARIO_META,
		platformSupportsAutoPost,
		type ScenarioSlug,
	} from '@pitchbox/shared/campaigns';
	import CampaignRecommendationsList, {
		type Recommendation,
	} from '$lib/components/projects/CampaignRecommendationsList.svelte';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import CronScheduleField from '$lib/components/campaigns/CronScheduleField.svelte';
	import { untrack } from 'svelte';

	let { data }: { data: PageData } = $props();

	const locale = $derived($page.data.locale as Locale);
	const isAdmin = $derived(data.isAdmin ?? true);

	// Seed every form-field state from `data` exactly once. Wrapping in
	// untrack() silences state_referenced_locally - the initial value should
	// not re-fire if SvelteKit reruns the load function.
	let projectId = $state<number | null>(
		untrack(() => data.preselected?.projectId ?? data.projects[0]?.id ?? null),
	);
	// When the page is preselected from a recommendation, prefer the platform that
	// matches the scenario so the scenario dropdown isn't filtered out.
	let platformSlug = $state<string>(
		untrack(() => {
			const presetSlug = data.preselected?.scenarioSlug;
			if (presetSlug) {
				const meta = SCENARIO_META.find((s) => s.slug === presetSlug);
				if (meta) return meta.platformSlug;
			}
			return data.platforms[0]?.slug ?? 'reddit';
		}),
	);
	let scenarioSlug = $state<ScenarioSlug>(
		untrack(() => (data.preselected?.scenarioSlug as ScenarioSlug) ?? 'reddit-scout'),
	);
	let name = $state(untrack(() => data.preselected?.name ?? ''));
	// Pre-select the first available runner. Because the runner list is cloud-first
	// (AGENT_RUNNER_META) and `data.runners` is already filtered to this
	// deployment's edition (#410), this picks the cloud runner whenever it is
	// configured. Falls back to claude-code when it is one of the allowed
	// runners and none is detected as available yet, or to whatever heads the
	// (edition-filtered) list otherwise - cloud edition never falls through to
	// a slug it cannot dispatch.
	let runner = $state<string>(
		untrack(
			() =>
				data.runners.find((r) => r.available)?.slug ??
				data.runners.find((r) => r.slug === 'claude-code')?.slug ??
				data.runners[0]?.slug ??
				'claude-code',
		),
	);
	let objective = $state(untrack(() => data.preselected?.objective ?? ''));
	let cron = $state('');
	let cronValid = $state(true);
	let autoPost = $state(false);
	let saving = $state(false);
	let preselectedRecId = $state<number | null>(untrack(() => data.preselected?.id ?? null));
	let recommendations = $state<Recommendation[]>(untrack(() => data.recommendations));

	async function loadRecommendationsFor(pid: number) {
		try {
			const res = await fetch(`/api/projects/${pid}/recommendations`);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
				if (res.status >= 500) {
					console.error('failed to load campaign recommendations', pid, res.status, body);
				}
				recommendations = [];
				toast.error(body.error ?? body.message ?? t(locale, 'campaigns.new.error-load-recommendations'));
				return;
			}
			const body = await res.json();
			recommendations = body.recommendations ?? [];
		} catch {
			recommendations = [];
			toast.error(t(locale, 'campaigns.new.error-load-recommendations-network'));
		}
	}

	const projectOptions = $derived(data.projects.map((p) => ({ value: p.id, label: p.name })));
	const platformOptions = $derived(data.platforms.map((p) => ({ value: p.slug, label: p.slug })));
	const scenarioOptions = $derived(
		SCENARIO_META.filter((s) => s.platformSlug === platformSlug).map((s) => ({
			value: s.slug,
			label: s.label,
		})),
	);
	const runnerOptions = $derived(
		data.runners.map((r) => {
			let label = r.label;
			if (!r.implemented) label = t(locale, 'campaigns.new.runner-not-available', { label: r.label });
			else if (!r.available) label = t(locale, 'campaigns.new.runner-not-installed', { label: r.label });
			return { value: r.slug, label, disabled: !r.available };
		}),
	);
	const selectedScenarioDescription = $derived(
		SCENARIO_META.find((s) => s.slug === scenarioSlug)?.description ?? '',
	);
	const autoPostSupported = $derived(platformSupportsAutoPost(platformSlug));

	// The platform can change independently of the toggle (picker, a
	// recommendation preset). Force it back off whenever the selected platform
	// doesn't support auto-post so a stale `true` can't sneak into the request
	// after the field is hidden.
	$effect(() => {
		if (!autoPostSupported) autoPost = false;
	});

	async function submit() {
		if (saving) return;
		if (!projectId || !name.trim() || !objective.trim()) {
			toast.error(t(locale, 'campaigns.new.error-fill-required'));
			return;
		}
		if (cron.trim() && !cronValid) {
			toast.error(t(locale, 'campaigns.detail.cron-invalid'));
			return;
		}
		saving = true;
		try {
			const res = await fetch('/api/campaigns', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					projectId,
					platformSlug,
					scenarioSlug,
					name,
					agentRunner: runner,
					objective,
					cronExpression: cron.trim() || undefined,
					autoPost: autoPostSupported ? autoPost : false,
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				toast.error(body.message ?? body.error ?? t(locale, 'campaigns.new.error-create-failed'));
				return;
			}
			toast.success(t(locale, 'campaigns.new.toast-created'));
			// Deleting the used recommendation is an admin-only action (cleanup only,
			// non-critical to the campaign-creation flow). Members skip it - the
			// recommendation just stays around unused.
			if (preselectedRecId !== null && isAdmin) {
				fetch(`/api/projects/${projectId}/recommendations/${preselectedRecId}`, {
					method: 'DELETE',
				}).catch(() => {});
			}
			await goto(`/campaigns/${body.id}`);
		} finally {
			saving = false;
		}
	}
</script>

<PageContainer size="narrow">
<h1 class="text-2xl font-semibold mb-6">{t(locale, 'campaigns.new.title')}</h1>

{#if !preselectedRecId && recommendations.length > 0}
	<div class="space-y-2 mb-6">
		<h2 class="text-sm font-medium">{t(locale, 'campaigns.new.suggestions-heading')}</h2>
		<CampaignRecommendationsList
			{recommendations}
			onUse={(rec) => {
				const slug = rec.scenarioSlug as ScenarioSlug;
				scenarioSlug = slug;
				const meta = SCENARIO_META.find((s) => s.slug === slug);
				if (meta) platformSlug = meta.platformSlug;
				name = rec.name;
				objective = rec.objective;
				preselectedRecId = rec.id;
			}}
		/>
	</div>
{/if}

<form
	class="space-y-6 max-w-2xl"
	onsubmit={(e) => {
		e.preventDefault();
		submit();
	}}
>
	<label class="flex flex-col gap-1 text-xs">
		{t(locale, 'campaigns.col-project')}
		<SelectField
			value={projectId ?? undefined}
			onValueChange={(v) => {
				projectId = v as number;
				loadRecommendationsFor(projectId);
			}}
			options={projectOptions}
			fullWidth
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		{t(locale, 'campaigns.new.field-platform')}
		<SelectField
			value={platformSlug}
			onValueChange={(v) => (platformSlug = v as string)}
			options={platformOptions}
			fullWidth
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		{t(locale, 'campaigns.new.field-scenario')}
		<SelectField
			value={scenarioSlug}
			onValueChange={(v) => (scenarioSlug = v as ScenarioSlug)}
			options={scenarioOptions}
			fullWidth
		/>
		<span class="text-xs text-muted-foreground">{selectedScenarioDescription}</span>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		{t(locale, 'campaigns.new.field-name')}
		<Input bind:value={name} placeholder={t(locale, 'campaigns.new.field-name-placeholder')} />
	</label>
	<label class="flex flex-col gap-1 text-xs">
		{t(locale, 'campaigns.new.field-runner')}
		<SelectField
			value={runner}
			onValueChange={(v) => (runner = v as string)}
			options={runnerOptions}
			fullWidth
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		{t(locale, 'campaigns.new.field-objective')}
		<Textarea
			bind:value={objective}
			rows={5}
			placeholder={t(locale, 'campaigns.new.field-objective-placeholder')}
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		{t(locale, 'campaigns.new.field-cron')}
		<CronScheduleField bind:value={cron} bind:valid={cronValid} />
	</label>
	{#if autoPostSupported}
		<label class="flex items-center gap-2 text-xs">
			<Checkbox checked={autoPost} onCheckedChange={(v) => (autoPost = v)} />
			{t(locale, 'campaigns.new.auto-post-checkbox-label')}
		</label>
		<p class="text-xs text-muted-foreground -mt-4">
			{t(locale, 'campaigns.new.auto-post-help')}
		</p>
	{/if}
	<div class="flex gap-2">
		<Button type="submit" loading={saving}>{t(locale, 'campaigns.new.create-button')}</Button>
		<Button type="button" variant="ghost" onclick={() => goto('/campaigns')}>{t(locale, 'campaigns.cancel')}</Button>
	</div>
</form>
</PageContainer>
