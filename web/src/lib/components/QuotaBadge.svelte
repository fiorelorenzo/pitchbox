<script lang="ts">
	import type { QuotaKind, UsageByKind, QuotaLimits } from '@pitchbox/shared/quota-types';

	let {
		kind,
		usage,
		limits,
	}: {
		kind: QuotaKind;
		usage: UsageByKind;
		limits: QuotaLimits;
	} = $props();

	const u = $derived(usage[kind]);
	const l = $derived(limits[kind]);
	const ratio = $derived(l.perDay === 0 ? 1 : u.day / l.perDay);
	const tone = $derived(
		u.day > l.perDay || u.week > l.perWeek
			? 'red-strong'
			: u.day === l.perDay
				? 'red'
				: ratio >= 0.8
					? 'yellow'
					: 'green',
	);

	const klass = $derived(
		{
			green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
			yellow: 'bg-amber-50 text-amber-700 ring-amber-200',
			red: 'bg-red-50 text-red-700 ring-red-200',
			'red-strong': 'bg-red-100 text-red-800 ring-red-300',
		}[tone],
	);

	const label = $derived({ dm: 'DM', comment: 'commenti', post: 'post' }[kind]);
	const tooltip = $derived(`${u.day}/${l.perDay} oggi · ${u.week}/${l.perWeek} questa settimana`);
</script>

<span
	class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 {klass}"
	title={tooltip}
>
	{u.day}/{l.perDay} {label}
	{#if tone === 'red-strong'}<span aria-hidden="true">⚠</span>{/if}
</span>
