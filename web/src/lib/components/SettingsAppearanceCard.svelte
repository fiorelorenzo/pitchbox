<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { SunMoon } from '@lucide/svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
</script>

<Card.Root size="sm">
	<Card.Header class="flex flex-row flex-nowrap items-center gap-2 space-y-0">
		<SunMoon class="size-4 shrink-0 text-muted-foreground" />
		<Card.Title class="text-base min-w-0 flex-1 truncate">Appearance</Card.Title>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<div class="flex flex-col gap-1.5">
			<span class="text-xs font-medium text-muted-foreground">
				Theme
			</span>
			<ThemeToggle />
			<p class="text-xs text-muted-foreground">Follow system or pick light or dark explicitly.</p>
		</div>
	</Card.Content>
</Card.Root>
