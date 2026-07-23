import type { Dict } from './types.js';

export const en: Dict = {
  'app.name': 'Pitchbox',
  'app.tagline': 'Outreach companion',

  'nav.dashboard': 'Dashboard',
  'nav.activity': 'Activity',
  'nav.settings': 'Settings',

  'dashboard.connection.title': 'Connection',
  'dashboard.connection.connected': 'Connected',
  'dashboard.connection.disconnected': 'Not connected',
  'dashboard.connection.empty': 'Not paired yet. Open your Pitchbox dashboard and click below.',
  'dashboard.connection.pair': 'Pair with this tab',
  'dashboard.connection.pair-another': 'Pair with another tab',
  'dashboard.connection.disconnect': 'Disconnect',
  'dashboard.connection.handshake-ago': 'handshake {ago}',
  'dashboard.connection.sync-ago': 'sync {ago}',
  'dashboard.connection.default-hint': 'Defaults to {url}',
  'dashboard.connection.add-toggle': 'Add with a pairing code',
  'dashboard.connection.add-hint':
    'Get a code from your dashboard (Settings -> Integrations), then connect without opening that tab.',
  'dashboard.connection.backend-placeholder': 'https://pitchbox.app',
  'dashboard.connection.code-placeholder': 'Pairing code',
  'dashboard.connection.connect': 'Connect',
  'dashboard.connection.connecting': 'Connecting...',
  'dashboard.connection.cancel': 'Cancel',
  'dashboard.connection.bad-url': 'Enter a valid backend URL',
  'dashboard.connection.code-required': 'Enter the pairing code',
  'dashboard.connection.perm-denied': 'Permission denied for {host}',
  'dashboard.connection.pair-failed': 'Pairing failed: {reason}',
  'dashboard.connection.degraded': 'Needs attention',
  'dashboard.connection.sync-error': 'Sync error',
  'dashboard.connection.test': 'Test connection',
  'dashboard.connection.testing': 'Testing...',
  'dashboard.connection.test-ok': 'Connected - server v{version}',
  'dashboard.connection.test-fail': 'Test failed: {reason}',
  'dashboard.connection.consent-title': 'Share Reddit activity with {host}?',
  'dashboard.connection.consent-body':
    'Every paired backend receives the full stream of Reddit DM, comment, and chat message bodies this extension captures.',
  'dashboard.connection.consent-confirm': 'Confirm & pair',
  'dashboard.connection.consent-review-title': 'Review what {host} receives',
  'dashboard.connection.consent-ack': 'Got it',

  'dashboard.sync.title': 'Sync',
  'dashboard.sync.now': 'Sync now',
  'dashboard.sync.syncing': 'Syncing…',
  'dashboard.sync.last': 'Last run: {ago}',
  'dashboard.sync.next': 'Next run: in {mins} min',
  'dashboard.sync.counters': '{inserted} new · {replied} replied',
  'dashboard.sync.never': 'never',

  'dashboard.token.title': 'Reddit token',
  'dashboard.token.ok': 'Reddit Chat token captured.',
  'dashboard.token.unauthorized':
    'Reddit Chat sync paused. Open reddit.com so the extension can capture a fresh token.',
  'dashboard.token.unknown': 'No Reddit Chat token yet. Open reddit.com to capture one.',
  'dashboard.token.open-reddit': 'Open reddit.com',

  'activity.title': 'Activity',
  'activity.empty': 'No activity yet.',
  'activity.filter.level': 'Level',
  'activity.filter.source': 'Source',
  'activity.filter.search': 'Search messages…',
  'activity.actions.clear': 'Clear',
  'activity.actions.export': 'Export JSON',
  'activity.clear.confirm-title': 'Clear activity log?',
  'activity.clear.confirm-body': 'All log entries will be removed. This cannot be undone.',
  'activity.clear.confirm-ok': 'Clear log',
  'activity.clear.cancel': 'Cancel',

  'activity.dm-sync.ok': 'Reddit inbox sync - {inserted} new, {replied} replied.',
  'activity.dm-sync.unauthorized': 'Reddit inbox sync paused - please log in to reddit.com.',
  'activity.dm-sync.error': 'Reddit inbox sync failed: {reason}',
  'activity.dm-sync.device-revoked':
    'A paired backend rejected this device (revoked). Re-pair from Settings > Integrations.',
  'activity.chat-sync.ok': 'Reddit Chat sync - {messages} messages, {inserted} new.',
  'activity.chat-sync.unauthorized': 'Reddit Chat sync paused - Matrix token expired.',
  'activity.chat-sync.error': 'Reddit Chat sync failed: {reason}',
  'activity.chat-sync.timeline-truncated':
    'Reddit Chat room {roomId} returned more messages than one sync could fetch; some may be delayed.',
  'activity.chat-sync.cursor-skip':
    'Reddit Chat sync advanced past an undelivered batch after {cycles} retries to a stuck backend.',
  'activity.pairing.added': 'Paired with {host}.',
  'activity.pairing.removed': 'Disconnected {host}.',
  'activity.matrix-token.captured': 'Captured Reddit Chat token.',
  'activity.matrix-token.cleared': 'Cleared Reddit Chat token.',
  'activity.reddit-action.dm-sent': 'Sent DM for draft {draftId}.',
  'activity.reddit-action.comment-sent': 'Posted comment for draft {draftId}.',
  'activity.reddit-action.submit-sent': 'Posted submission for draft {draftId}.',
  'activity.reddit-action.fail': 'Backend flip failed for draft {draftId}: {reason}',
  'activity.reddit-action.submit-button-not-found':
    'Could not find the Reddit submit button for draft {draftId}.',
  'activity.reddit-action.submit-no-t3':
    'Reddit submission for draft {draftId} navigated away without a post id.',
  'activity.reddit-action.submit-poll-timeout':
    'Timed out waiting for the Reddit submission for draft {draftId} to complete.',
  'activity.reddit-action.comment-box-missing':
    'Could not find the comment box for draft {draftId}; it was not pre-filled.',
  'activity.reddit-action.comment-submit-not-found':
    'Could not find the comment submit button for draft {draftId} within 15s; posting will not be tracked automatically.',
  'activity.reddit-action.comment-confirm-timeout':
    'Could not confirm draft {draftId} was posted within 20s after clicking submit; check its status manually.',
  'activity.reddit-action.send-button-not-found':
    'Gave up waiting for the DM send button for draft {draftId}.',
  'activity.reddit-action.send-poll-timeout': 'Gave up confirming draft {draftId} was sent.',
  'activity.settings.changed': 'Settings updated.',
  'activity.system.boot': 'Service worker started.',
  'activity.system.alarms-applied': 'Alarms re-applied ({interval} min).',
  'activity.system.upgraded': 'Extension upgraded {from} → {to}.',
  'activity.system.installed': 'Extension installed.',

  'settings.appearance.title': 'Appearance',
  'settings.appearance.theme': 'Theme',
  'settings.appearance.theme.light': 'Light',
  'settings.appearance.theme.dark': 'Dark',
  'settings.appearance.theme.system': 'System',
  'settings.appearance.density': 'Density',
  'settings.appearance.density.compact': 'Compact',
  'settings.appearance.density.comfortable': 'Comfortable',

  'settings.language.title': 'Language',
  'settings.language.locale': 'Locale',

  'settings.sync.title': 'Sync',
  'settings.sync.interval': 'Poller interval',
  'settings.sync.interval.5': 'Every 5 minutes',
  'settings.sync.interval.10': 'Every 10 minutes',
  'settings.sync.interval.15': 'Every 15 minutes',
  'settings.sync.interval.30': 'Every 30 minutes',
  'settings.sync.legacy': 'Legacy inbox poller',
  'settings.sync.chat': 'Reddit Chat poller',

  'settings.data.title': 'Data',
  'settings.data.clear-log': 'Clear activity log',
  'settings.data.reset': 'Reset extension',
  'settings.data.reset.confirm-title': 'Reset extension?',
  'settings.data.reset.confirm-body':
    'All pairings, settings and the activity log will be removed.',
  'settings.data.reset.confirm-ok': 'Reset',

  'settings.about.title': 'About',
  'settings.about.version': 'Version',
  'settings.about.github': 'GitHub',
  'settings.about.docs': 'Documentation',

  'time.never': 'never',
  'time.seconds-ago': '{n}s ago',
  'time.minutes-ago': '{n}m ago',
  'time.hours-ago': '{n}h ago',
  'time.days-ago': '{n}d ago',

  'test.only-en': 'only english',
};
