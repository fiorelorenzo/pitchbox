<script lang="ts">
  import { Textarea } from '$lib/components/ui/textarea';

  type Props = {
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
  };
  let { value, onChange, disabled = false }: Props = $props();
</script>

<section class="space-y-2">
  <header>
    <h3 class="text-sm font-semibold">Post angle</h3>
    <p class="text-xs text-muted-foreground">
      The framing the agent applies to every drafted post — e.g. "lessons learned from building X",
      "comparison: tool A vs tool B", "show: I shipped a small thing that solves Y". Keep it concrete.
    </p>
  </header>
  <Textarea
    value={value}
    oninput={(e) => onChange(e.currentTarget.value)}
    rows={3}
    {disabled}
    class="text-sm"
  />
</section>
