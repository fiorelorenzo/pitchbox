<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { Info } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<PageHeader
	title="Settings"
	description="Daemon status, agent runner configuration, and browser extension hookup. Most of this ships in later milestones (M2, M3)."
/>

<Card.Root class="max-w-2xl">
	<Card.Content class="flex flex-col gap-4 pt-6">
		<Alert.Root>
			<Info class="size-4" />
			<Alert.Title>Daemon</Alert.Title>
			<Alert.Description>
				Not yet implemented (M2). The scheduler and reply pollers will live here.
			</Alert.Description>
		</Alert.Root>

		<Alert.Root>
			<Info class="size-4" />
			<Alert.Title>Agent runner</Alert.Title>
			<Alert.Description>
				Currently using <code class="text-xs font-mono">claude-code</code> (Claude Code CLI subprocess).
				Configuration UI in a later milestone.
			</Alert.Description>
		</Alert.Root>

		<Alert.Root>
			<Info class="size-4" />
			<Alert.Title>Browser extension</Alert.Title>
			<Alert.Description>
				Not yet implemented (M3). Will manage the mark-as-sent and DM reply sync.
			</Alert.Description>
		</Alert.Root>
	</Card.Content>
</Card.Root>
