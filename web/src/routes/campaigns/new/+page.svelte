<script lang="ts">
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SelectField } from '$lib/components/ui/select-field';
	import { toast } from 'svelte-sonner';
	import { SCENARIO_META, type ScenarioSlug } from '@pitchbox/shared/campaigns';
	import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
	import CampaignRecommendationsList, {
		type Recommendation,
	} from '$lib/components/projects/CampaignRecommendationsList.svelte';
	import { untrack } from 'svelte';

	let { data }: { data: PageData } = $props();
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
	// (AGENT_RUNNER_META), this picks the cloud runner whenever it is configured, so
	// the user just sees the cloud runner in use. Falls back to claude-code when no
	// runner is detected as available yet.
	let runner = $state<string>(
		untrack(() => data.runners.find((r) => r.available)?.slug ?? 'claude-code'),
	);
	let objective = $state(untrack(() => data.preselected?.objective ?? ''));
	let cron = $state('');
	let saving = $state(false);
	let preselectedRecId = $state<number | null>(untrack(() => data.preselected?.id ?? null));
	let recommendations = $state<Recommendation[]>(untrack(() => data.recommendations));

	async function loadRecommendationsFor(pid: number) {
		const res = await fetch(`/api/projects/${pid}/recommendations`);
		if (!res.ok) {
			recommendations = [];
			return;
		}
		const body = await res.json();
		recommendations = body.recommendations ?? [];
	}

	const projectOptions = $derived(data.projects.map((p) => ({ value: p.id, label: p.name })));
	const platformOptions = $derived(data.platforms.map((p) => ({ value: p.slug, label: p.slug })));
	const scenarioOptions = $derived(
		SCENARIO_META.filter((s) => s.platformSlug === platformSlug).map((s) => ({
			value: s.slug,
			label: s.label,
		})),
	);
	const runnerOptions = AGENT_RUNNER_META.map((m) => {
		const det = data.runners.find((r) => r.slug === m.slug);
		const available = det?.available ?? false;
		let label = m.label;
		if (!m.implemented) label = `${m.label} (coming soon)`;
		else if (!available) label = `${m.label} (not installed)`;
		return { value: m.slug, label, disabled: !available };
	});
	const selectedScenarioDescription = $derived(
		SCENARIO_META.find((s) => s.slug === scenarioSlug)?.description ?? '',
	);

	async function submit() {
		if (saving) return;
		if (!projectId || !name.trim() || !objective.trim()) {
			toast.error('Fill all required fields');
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
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				toast.error(body.message ?? body.error ?? 'Failed to create campaign');
				return;
			}
			toast.success('Campaign created - generating profile');
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

<h1 class="text-2xl font-semibold mb-6">New campaign</h1>

{#if !preselectedRecId && recommendations.length > 0}
	<div class="space-y-2 mb-6">
		<h2 class="text-sm font-medium">Suggested campaigns for this project</h2>
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
		Project
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
		Platform
		<SelectField
			value={platformSlug}
			onValueChange={(v) => (platformSlug = v as string)}
			options={platformOptions}
			fullWidth
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		Scenario
		<SelectField
			value={scenarioSlug}
			onValueChange={(v) => (scenarioSlug = v as ScenarioSlug)}
			options={scenarioOptions}
			fullWidth
		/>
		<span class="text-xs text-muted-foreground">{selectedScenarioDescription}</span>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		Name
		<Input bind:value={name} placeholder="e.g. Reddit RPG launch" />
	</label>
	<label class="flex flex-col gap-1 text-xs">
		Agent runner
		<SelectField
			value={runner}
			onValueChange={(v) => (runner = v as string)}
			options={runnerOptions}
			fullWidth
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		Objective
		<Textarea
			bind:value={objective}
			rows={5}
			placeholder="Find tabletop RPG players curious about AI Game Masters and invite them to try the closed alpha."
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		Cron (optional)
		<Input bind:value={cron} placeholder="0 9 * * *" />
	</label>
	<div class="flex gap-2">
		<Button type="submit" loading={saving}>Create</Button>
		<Button type="button" variant="ghost" onclick={() => goto('/campaigns')}>Cancel</Button>
	</div>
</form>
