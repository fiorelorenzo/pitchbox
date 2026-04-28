<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Info } from 'lucide-svelte';

	type QuotaWindow = { perDay: number; perWeek: number };
	type PlatformQuota = { dm: QuotaWindow; comment: QuotaWindow; post: QuotaWindow };

	let {
		slug,
		limits = $bindable(),
		defaults,
		onreset,
	}: {
		slug: string;
		limits: PlatformQuota;
		defaults: PlatformQuota;
		onreset?: () => void;
	} = $props();

	const KIND_LABEL: Record<keyof PlatformQuota, string> = {
		dm: 'DMs',
		comment: 'Comments',
		post: 'Posts',
	};

	const HELP: Record<keyof PlatformQuota, string> = {
		dm: "Direct messages. Reddit doesn't publish an official limit; under 15/day is considered low-risk for accounts with organic history.",
		comment:
			'Sum of post comments + comment replies. Reddit applies implicit throttling on new accounts.',
		post: "Published posts. Post-draft generation isn't wired up yet — the limit is here for future use.",
	};

	const KINDS: (keyof PlatformQuota)[] = ['dm', 'comment', 'post'];

	const platformLabel = $derived(slug[0].toUpperCase() + slug.slice(1));
</script>

<Card.Root>
	<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
		<Card.Title class="flex-1">{platformLabel}</Card.Title>
		<Button variant="ghost" size="sm" onclick={onreset}>Reset to defaults</Button>
	</Card.Header>
	<Card.Content>
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b">
					<th class="pb-2 text-left font-medium text-muted-foreground w-36">Kind</th>
					<th class="pb-2 text-left font-medium text-muted-foreground">Per day</th>
					<th class="pb-2 text-left font-medium text-muted-foreground">Per week</th>
					<th class="pb-2 w-6"></th>
				</tr>
			</thead>
			<tbody>
				{#each KINDS as kind}
					<tr class="border-b last:border-0">
						<td class="py-2 pr-4 font-medium">{KIND_LABEL[kind]}</td>
						<td class="py-2 pr-4">
							<Input
								type="number"
								min="0"
								class="w-24 h-7 text-sm"
								bind:value={limits[kind].perDay}
							/>
						</td>
						<td class="py-2 pr-4">
							<Input
								type="number"
								min="0"
								class="w-24 h-7 text-sm"
								bind:value={limits[kind].perWeek}
							/>
						</td>
						<td class="py-2">
							<Tooltip.Root>
								<Tooltip.Trigger>
									<Info class="size-4 text-muted-foreground" />
								</Tooltip.Trigger>
								<Tooltip.Content>
									{HELP[kind]}
								</Tooltip.Content>
							</Tooltip.Root>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</Card.Content>
</Card.Root>
