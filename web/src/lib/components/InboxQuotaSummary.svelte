<script lang="ts">
	import type { QuotaKind, WindowCounts } from '@pitchbox/shared/quota-types';

	let {
		quotaKind,
		quotaLabel,
		accounts,
	}: {
		quotaKind: QuotaKind;
		quotaLabel: string;
		accounts: Array<{
			id: number;
			handle: string;
			usage: WindowCounts;
			limits: { perDay: number; perWeek: number };
		}>;
	} = $props();

	function tone(u: WindowCounts, l: { perDay: number; perWeek: number }) {
		if (u.day > l.perDay || u.week > l.perWeek) return 'red-strong';
		if (u.day === l.perDay) return 'red';
		const ratio = l.perDay === 0 ? 1 : u.day / l.perDay;
		if (ratio >= 0.8) return 'yellow';
		return 'green';
	}

	const toneClass: Record<string, string> = {
		green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
		yellow: 'bg-amber-50 text-amber-700 ring-amber-200',
		red: 'bg-red-50 text-red-700 ring-red-200',
		'red-strong': 'bg-red-100 text-red-800 ring-red-300',
	};
</script>

<div class="flex flex-wrap items-center gap-2 mb-3 text-xs">
	<span class="text-muted-foreground font-medium">Inviati oggi —</span>
	{#each accounts as account (account.id)}
		{@const t = tone(account.usage, account.limits)}
		<span
			class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 {toneClass[t]}"
			title={`${account.usage.day}/${account.limits.perDay} oggi · ${account.usage.week}/${account.limits.perWeek} questa settimana`}
		>
			@{account.handle}: {account.usage.day}/{account.limits.perDay} {quotaLabel}
			{#if t === 'red-strong'}<span aria-hidden="true">⚠</span>{/if}
		</span>
	{/each}
</div>
