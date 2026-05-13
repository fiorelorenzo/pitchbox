import type { Dict } from './types.js';

export const it: Dict = {
  'app.name': 'Pitchbox',
  'app.tagline': 'Compagno di outreach',

  'nav.dashboard': 'Dashboard',
  'nav.activity': 'Attività',
  'nav.settings': 'Impostazioni',

  'dashboard.connection.title': 'Connessione',
  'dashboard.connection.connected': 'Connesso',
  'dashboard.connection.disconnected': 'Non connesso',
  'dashboard.connection.empty':
    'Nessun pairing. Apri la dashboard di Pitchbox e clicca qui sotto.',
  'dashboard.connection.pair': 'Abbina questo tab',
  'dashboard.connection.pair-another': 'Abbina un altro tab',
  'dashboard.connection.disconnect': 'Disconnetti',
  'dashboard.connection.handshake-ago': 'handshake {ago}',
  'dashboard.connection.sync-ago': 'sync {ago}',

  'dashboard.sync.title': 'Sincronizzazione',
  'dashboard.sync.now': 'Sincronizza ora',
  'dashboard.sync.syncing': 'Sincronizzazione…',
  'dashboard.sync.last': 'Ultimo run: {ago}',
  'dashboard.sync.next': 'Prossimo run: tra {mins} min',
  'dashboard.sync.counters': '{inserted} nuovi · {replied} risposti',
  'dashboard.sync.never': 'mai',

  'dashboard.token.title': 'Token Reddit',
  'dashboard.token.ok': 'Token di Reddit Chat catturato.',
  'dashboard.token.unauthorized':
    'Sync di Reddit Chat in pausa. Apri reddit.com per catturare un token aggiornato.',
  'dashboard.token.unknown':
    'Nessun token di Reddit Chat ancora. Apri reddit.com per catturarne uno.',
  'dashboard.token.open-reddit': 'Apri reddit.com',

  'activity.title': 'Attività',
  'activity.empty': 'Nessuna attività ancora.',
  'activity.filter.level': 'Livello',
  'activity.filter.source': 'Sorgente',
  'activity.filter.search': 'Cerca messaggi…',
  'activity.actions.clear': 'Svuota',
  'activity.actions.export': 'Esporta JSON',
  'activity.clear.confirm-title': 'Svuotare il log?',
  'activity.clear.confirm-body':
    'Tutte le voci del log saranno rimosse. L’operazione non è reversibile.',
  'activity.clear.confirm-ok': 'Svuota',
  'activity.clear.cancel': 'Annulla',

  'activity.dm-sync.ok': 'Sync inbox Reddit - {inserted} nuovi, {replied} risposti.',
  'activity.dm-sync.unauthorized': 'Sync inbox Reddit in pausa - fai login su reddit.com.',
  'activity.dm-sync.error': 'Sync inbox Reddit fallito: {reason}',
  'activity.chat-sync.ok': 'Sync Reddit Chat - {messages} messaggi, {inserted} nuovi.',
  'activity.chat-sync.unauthorized': 'Sync Reddit Chat in pausa - token Matrix scaduto.',
  'activity.chat-sync.error': 'Sync Reddit Chat fallito: {reason}',
  'activity.pairing.added': 'Abbinato a {host}.',
  'activity.pairing.removed': 'Disconnesso {host}.',
  'activity.matrix-token.captured': 'Token di Reddit Chat catturato.',
  'activity.matrix-token.cleared': 'Token di Reddit Chat rimosso.',
  'activity.reddit-action.dm-sent': 'DM inviato per il draft {draftId}.',
  'activity.reddit-action.comment-sent': 'Commento pubblicato per il draft {draftId}.',
  'activity.reddit-action.submit-sent': 'Post pubblicato per il draft {draftId}.',
  'activity.reddit-action.fail':
    'Aggiornamento backend fallito per il draft {draftId}: {reason}',
  'activity.settings.changed': 'Impostazioni aggiornate.',
  'activity.system.boot': 'Service worker avviato.',
  'activity.system.alarms-applied': 'Alarms riapplicati ({interval} min).',
  'activity.system.upgraded': 'Estensione aggiornata {from} → {to}.',

  'settings.appearance.title': 'Aspetto',
  'settings.appearance.theme': 'Tema',
  'settings.appearance.theme.light': 'Chiaro',
  'settings.appearance.theme.dark': 'Scuro',
  'settings.appearance.theme.system': 'Sistema',
  'settings.appearance.density': 'Densità',
  'settings.appearance.density.compact': 'Compatta',
  'settings.appearance.density.comfortable': 'Comoda',

  'settings.language.title': 'Lingua',
  'settings.language.locale': 'Locale',

  'settings.sync.title': 'Sincronizzazione',
  'settings.sync.interval': 'Intervallo del poller',
  'settings.sync.interval.5': 'Ogni 5 minuti',
  'settings.sync.interval.10': 'Ogni 10 minuti',
  'settings.sync.interval.15': 'Ogni 15 minuti',
  'settings.sync.interval.30': 'Ogni 30 minuti',
  'settings.sync.legacy': 'Poller legacy dell’inbox',
  'settings.sync.chat': 'Poller Reddit Chat',

  'settings.data.title': 'Dati',
  'settings.data.clear-log': 'Svuota log delle attività',
  'settings.data.reset': 'Reset estensione',
  'settings.data.reset.confirm-title': 'Resettare l’estensione?',
  'settings.data.reset.confirm-body':
    'Tutti i pairing, le impostazioni e il log saranno rimossi.',
  'settings.data.reset.confirm-ok': 'Reset',

  'settings.about.title': 'Informazioni',
  'settings.about.version': 'Versione',
  'settings.about.github': 'GitHub',
  'settings.about.docs': 'Documentazione',

  'time.never': 'mai',
  'time.seconds-ago': '{n}s fa',
  'time.minutes-ago': '{n}m fa',
  'time.hours-ago': '{n}h fa',
  'time.days-ago': '{n}g fa',
};
