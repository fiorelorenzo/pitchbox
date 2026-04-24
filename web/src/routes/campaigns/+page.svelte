<svelte:options runes={false} />

<script lang="ts">
	import SpinnerButton from '$lib/components/SpinnerButton.svelte';
	import RunLog from '$lib/components/RunLog.svelte';
	import { invalidateAll } from '$app/navigation';

	export let data: { campaigns: any[]; recentRuns: any[] };

	let runningCampaignId: number | null = null;
	let currentRunId: number | null = null;

	async function runNow(id: number) {
		runningCampaignId = id;
		try {
			const res = await fetch('/api/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ campaignId: id }),
			});
			if (!res.ok) throw new Error(await res.text());
			const { runId } = await res.json();
			currentRunId = runId;
			await invalidateAll();
		} finally {
			runningCampaignId = null;
		}
	}
</script>

<h1 class="text-2xl font-semibold mb-6">Campaigns</h1>

<div class="grid gap-6 lg:grid-cols-[1fr_400px]">
	<section>
		<table class="w-full text-sm">
			<thead class="border-b border-slate-800 text-left">
				<tr><th class="py-2">Name</th><th>Skill</th><th>Status</th><th></th></tr>
			</thead>
			<tbody>
				{#each data.campaigns as c (c.id)}
					<tr class="border-b border-slate-900">
						<td class="py-2">{c.name}</td>
						<td>{c.skillSlug}</td>
						<td>{c.status}</td>
						<td class="text-right">
							<SpinnerButton loading={runningCampaignId === c.id} on:click={() => runNow(c.id)}>
								Run now
							</SpinnerButton>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
	<aside>
		<h2 class="text-sm font-semibold text-slate-400 mb-2">Live log</h2>
		<RunLog runId={currentRunId} />
	</aside>
</div>
