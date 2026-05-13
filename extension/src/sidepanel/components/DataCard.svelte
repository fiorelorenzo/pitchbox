<!-- Data management: clear activity log + reset entire extension. -->
<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from '$ui/card';
  import { Button } from '$ui/button';
  import * as AlertDialog from '$ui/alert-dialog';
  import { t } from '$ext/i18n';
  import { clearActivity } from '$ext/activity';

  let confirmOpen = $state(false);

  async function resetAll() {
    confirmOpen = false;
    await chrome.storage.local.clear();
    await chrome.alarms.clearAll();
    location.reload();
  }
</script>

<Card>
  <CardHeader><CardTitle>{$t('settings.data.title')}</CardTitle></CardHeader>
  <CardContent class="flex flex-col gap-3">
    <Button variant="outline" onclick={() => clearActivity()}>
      {$t('settings.data.clear-log')}
    </Button>

    <Button variant="destructive" onclick={() => (confirmOpen = true)}>
      {$t('settings.data.reset')}
    </Button>

    <AlertDialog.Root bind:open={confirmOpen}>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{$t('settings.data.reset.confirm-title')}</AlertDialog.Title>
          <AlertDialog.Description>{$t('settings.data.reset.confirm-body')}</AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <AlertDialog.Cancel onclick={() => (confirmOpen = false)}>
            {$t('activity.clear.cancel')}
          </AlertDialog.Cancel>
          <AlertDialog.Action onclick={resetAll}>
            {$t('settings.data.reset.confirm-ok')}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  </CardContent>
</Card>
