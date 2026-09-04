import { en } from './dict-en.js';

export const it = {
  'app.name': 'Pitchbox',
  'app.tagline': 'Compagno di outreach',

  'nav.dashboard': 'Dashboard',
  'nav.activity': 'Attività',
  'nav.settings': 'Impostazioni',

  'dashboard.connection.title': 'Connessione',
  'dashboard.connection.connected': 'Connesso',
  'dashboard.connection.disconnected': 'Non connesso',
  'dashboard.connection.empty':
    'Apri la dashboard di Pitchbox, accedi, poi abbina da quella scheda.',
  'dashboard.connection.pair': 'Abbina questo tab',
  'dashboard.connection.pair-another': 'Abbina un altro tab',
  'dashboard.connection.disconnect': 'Disconnetti',
  'dashboard.connection.handshake-ago': 'handshake {ago}',
  'dashboard.connection.sync-ago': 'sync {ago}',
  'dashboard.connection.default-hint': 'Usi un codice di pairing? Il valore predefinito è {url}.',
  'dashboard.connection.add-toggle': 'Aggiungi con un codice',
  'dashboard.connection.add-hint':
    'Genera un codice dalla dashboard (Impostazioni -> Integrazioni), poi collega senza aprire quella scheda.',
  'dashboard.connection.backend-placeholder': 'https://pitchbox.app',
  'dashboard.connection.code-placeholder': 'Codice di pairing',
  'dashboard.connection.connect': 'Collega',
  'dashboard.connection.connecting': 'Collegamento...',
  'dashboard.connection.cancel': 'Annulla',
  'dashboard.connection.bad-url': 'Inserisci un URL backend valido',
  'dashboard.connection.code-required': 'Inserisci il codice di pairing',
  'dashboard.connection.perm-denied': 'Permesso negato per {host}',
  'dashboard.connection.perm-request-failed':
    'Impossibile richiedere il permesso per {host}. Riprova.',
  'dashboard.connection.pair-failed': 'Pairing fallito: {reason}',
  'dashboard.connection.pairing': 'Abbinamento...',
  'dashboard.connection.pair-error-unauthorized':
    "Non hai eseguito l'accesso alla dashboard in quella scheda. Accedi, poi riprova.",
  'dashboard.connection.pair-error-no-dashboard':
    'Nessuna dashboard di Pitchbox trovata in quella scheda. Apri la dashboard, poi riprova.',
  'dashboard.connection.pair-error-network':
    'Impossibile raggiungere la dashboard. Controlla la connessione, poi riprova.',
  'dashboard.connection.pair-error-server':
    'La dashboard ha restituito un errore imprevisto. Riprova tra poco.',
  'dashboard.connection.degraded': 'Richiede attenzione',
  'dashboard.connection.sync-error': 'Errore di sincronizzazione',
  'dashboard.connection.test': 'Testa connessione',
  'dashboard.connection.testing': 'Test in corso...',
  'dashboard.connection.test-ok': 'Connesso - server v{version}',
  'dashboard.connection.test-fail': 'Test fallito: {reason}',
  'dashboard.connection.consent-title': "Condividere l'attività Reddit con {host}?",
  'dashboard.connection.consent-body':
    "Ogni backend abbinato riceve l'intero flusso di DM, commenti e messaggi chat di Reddit catturati da questa estensione.",
  'dashboard.connection.consent-confirm': 'Conferma e abbina',
  'dashboard.connection.consent-review-title': 'Rivedi cosa riceve {host}',
  'dashboard.connection.consent-ack': 'Ho capito',

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
  'activity.actions.export-done': 'Esportati {n} eventi.',
  'activity.retention-notice':
    '{count} voci precedenti a {oldest} sono state eliminate per rispettare il limite di {cap} voci.',
  'activity.clear.confirm-title': 'Svuotare il log?',
  'activity.clear.confirm-body':
    'Tutte le voci del log saranno rimosse. L’operazione non è reversibile.',
  'activity.clear.confirm-ok': 'Svuota',
  'activity.clear.cancel': 'Annulla',

  'activity.dm-sync.ok': 'Sync inbox Reddit - {inserted} nuovi, {replied} risposti.',
  'activity.dm-sync.unauthorized': 'Sync inbox Reddit in pausa - fai login su reddit.com.',
  'activity.dm-sync.error': 'Sync inbox Reddit fallito: {reason}',
  'activity.dm-sync.device-revoked':
    'Un backend abbinato ha rifiutato questo dispositivo (revocato). Ri-abbina da Impostazioni > Integrazioni.',
  'activity.chat-sync.ok': 'Sync Reddit Chat - {messages} messaggi, {inserted} nuovi.',
  'activity.chat-sync.unauthorized': 'Sync Reddit Chat in pausa - token Matrix scaduto.',
  'activity.chat-sync.error': 'Sync Reddit Chat fallito: {reason}',
  'activity.chat-sync.timeline-truncated':
    'La room Reddit Chat {roomId} ha restituito più messaggi di quanti una sync possa recuperarne; alcuni potrebbero arrivare in ritardo.',
  'activity.chat-sync.cursor-skip':
    'La sync Reddit Chat è avanzata oltre un batch non consegnato dopo {cycles} tentativi verso un backend bloccato.',
  'activity.pairing.added': 'Abbinato a {host}.',
  'activity.pairing.removed': 'Disconnesso {host}.',
  'activity.matrix-token.captured': 'Token di Reddit Chat catturato.',
  'activity.matrix-token.cleared': 'Token di Reddit Chat rimosso.',
  'activity.reddit-action.dm-sent': 'DM inviato per il draft {draftId}.',
  'activity.reddit-action.comment-sent': 'Commento pubblicato per il draft {draftId}.',
  'activity.reddit-action.submit-sent': 'Post pubblicato per il draft {draftId}.',
  'activity.reddit-action.fail': 'Aggiornamento backend fallito per il draft {draftId}: {reason}',
  'activity.reddit-action.submit-button-not-found':
    'Pulsante di invio Reddit non trovato per il draft {draftId}.',
  'activity.reddit-action.submit-no-t3':
    'Invio Reddit per il draft {draftId} interrotto senza id del post.',
  'activity.reddit-action.submit-poll-timeout':
    'Timeout: invio Reddit per il draft {draftId} non completato in tempo.',
  'activity.reddit-action.comment-box-missing':
    'Impossibile trovare il box del commento per il draft {draftId}; non è stato precompilato.',
  'activity.reddit-action.comment-submit-not-found':
    'Impossibile trovare il pulsante di invio del commento per il draft {draftId} entro 15s; la pubblicazione non verrà tracciata automaticamente.',
  'activity.reddit-action.comment-confirm-timeout':
    'Impossibile confermare che il draft {draftId} sia stato pubblicato entro 20s dal clic su invio; verifica manualmente lo stato.',
  'activity.reddit-action.send-button-not-found':
    'Rinunciato ad attendere il pulsante di invio del DM per il draft {draftId}.',
  'activity.reddit-action.send-poll-timeout':
    "Rinunciato a confermare l'invio del draft {draftId}.",
  'activity.reddit-action.compose-box-missing':
    'Impossibile trovare il box di composizione del DM per il draft {draftId}.',
  'activity.reddit-action.account-handle-unresolved':
    'Impossibile determinare il tuo account Reddit per il draft {draftId}; la corrispondenza delle risposte potrebbe essere meno precisa.',
  'activity.reddit-action.comment-id-unresolved':
    "Impossibile leggere l'id del commento pubblicato per il draft {draftId}; le risposte non verranno rilevate.",
  'activity.reddit-action.undeliverable': 'Il draft {draftId} non è recapitabile: {reason}',
  'activity.linkedin-action.comment-sent': 'Commento pubblicato per il draft {draftId}.',
  'activity.linkedin-action.fail': 'Aggiornamento backend fallito per il draft {draftId}: {reason}',
  'activity.linkedin-action.composer-missing':
    'Impossibile trovare il box del commento LinkedIn per il draft {draftId}; non è stato offerto.',
  'activity.linkedin-action.comment-submit-not-found':
    'Impossibile trovare il pulsante di invio del commento LinkedIn per il draft {draftId} entro 15s; la pubblicazione non verrà tracciata automaticamente.',
  'activity.linkedin-action.comment-confirm-timeout':
    'Impossibile confermare che il draft {draftId} sia stato pubblicato entro 20s dal clic su invio; verifica manualmente lo stato.',
  'activity.linkedin-action.assist-composer-not-found':
    "Impossibile trovare il box del commento LinkedIn; l'assistente non è stato offerto.",
  'activity.linkedin-action.suggestion-refused': 'Suggerimento LinkedIn assist rifiutato: {reason}',
  'activity.linkedin-action.suggestion-inserted':
    'Suggerimento accettato inserito nel box del commento LinkedIn per il draft {draftId}.',
  'activity.linkedin-dom.selector-miss':
    'Il selettore LinkedIn "{selector}" non trova corrispondenze nella pagina {pageKind} ({misses} mancate, {matches} trovate) - questa lettura potrebbe essere obsoleta o mancante.',
  'activity.linkedin-collector.batch-sent':
    'Osservazioni LinkedIn inviate - {inserted} nuove, {duplicates} duplicate, {dropped} scartate.',
  'activity.linkedin-collector.batch-failed':
    'Invio del batch di osservazioni LinkedIn fallito: {reason}',
  'activity.linkedin-collector.stopped': 'Collettore di osservazioni LinkedIn fermato: {reason}',
  'activity.settings.changed': 'Impostazioni aggiornate.',
  'activity.system.boot': 'Service worker avviato.',
  'activity.system.alarms-applied': 'Alarms riapplicati ({interval} min).',
  'activity.system.upgraded': 'Estensione aggiornata {from} → {to}.',
  'activity.system.installed': 'Estensione installata.',

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

  'settings.sync.title': 'Pianificazione sync',
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
  'settings.data.reset.confirm-body': 'Tutti i pairing, le impostazioni e il log saranno rimossi.',
  'settings.data.reset.confirm-ok': 'Reset',

  'settings.about.title': 'Informazioni',
  'settings.about.version': 'Versione',
  'settings.about.github': 'GitHub',
  'settings.about.docs': 'Documentazione',

  'settings.linkedin.title': 'Accesso a LinkedIn',
  'settings.linkedin.description':
    'Concedi l’accesso a LinkedIn per permettere all’assistente in pagina di leggere il post che stai visualizzando e suggerire un commento. Non viene richiesto nulla finché non lo concedi, e nessuna credenziale di LinkedIn lascia mai il tuo browser.',
  'settings.linkedin.granted': 'Concesso',
  'settings.linkedin.not-granted': 'Non concesso',
  'settings.linkedin.grant': 'Concedi accesso',
  'settings.linkedin.revoke': 'Revoca accesso',
  'settings.linkedin.denied': 'Permesso non concesso. Puoi riprovare quando vuoi.',
  'settings.linkedin.request-failed': 'Impossibile richiedere l’accesso a LinkedIn. Riprova.',

  'time.never': 'mai',
  'time.seconds-ago': '{n}s fa',
  'time.minutes-ago': '{n}m fa',
  'time.hours-ago': '{n}h fa',
  'time.days-ago': '{n}g fa',

  'activity.level.all': 'Tutti',
  'activity.level.info': 'Info',
  'activity.level.warn': 'Avviso',
  'activity.level.error': 'Errore',

  'activity.source.all': 'Tutte',
  'activity.source.pairing': 'Pairing',
  'activity.source.dm-sync': 'Sync DM',
  'activity.source.chat-sync': 'Sync chat',
  'activity.source.matrix-token': 'Token Matrix',
  'activity.source.reddit-action': 'Azione Reddit',
  'activity.source.settings': 'Impostazioni',
  'activity.source.system': 'Sistema',

  'dashboard.connection.no-active-tab': 'Nessuna scheda attiva',

  // In-page panel chrome. The wordmark is the product name, so it is not
  // translated; everything else on this surface is.
  'panel.title': 'Pitchbox',
  'panel.close': 'Chiudi',

  // In-page LinkedIn comment assist (LI-17, #314), see the comment in dict-en.ts.
  'assist.comment.resting.hint': 'Ottieni una risposta suggerita da Pitchbox per questo post.',
  'assist.comment.resting.cta': 'Suggerisci un commento',
  'assist.status.reading': 'Lettura del post in corso…',
  'assist.status.writing': 'Scrittura in corso…',
  'assist.comment.ready.label': 'Commento suggerito (modificabile)',
  'assist.action.accept': 'Inserisci',
  'assist.action.retry': 'Riprova',
  'assist.comment.accepting': 'Salvataggio in corso…',
  'assist.comment.inserted.title': 'Inserito',
  'assist.comment.inserted.hint': 'Premi il pulsante Commenta di LinkedIn per inviarlo.',
  'assist.refusal.assist_disabled': "L'assistente Pitchbox è disattivato per questo workspace.",
  'assist.refusal.kill_switch': "Un amministratore ha fermato l'assistente.",
  'assist.refusal.project_not_bound': "Nessun progetto è collegato all'assistente.",
  'assist.refusal.quota_exhausted': 'La quota commenti di oggi è esaurita.',
  'assist.refusal.no_account': 'Nessun account LinkedIn è collegato a questo progetto.',
  'assist.refusal.blocked': 'Questa persona è nella blocklist.',
  'assist.refusal.uncontactable': 'Questa persona è stata segnata come non contattabile.',
  'assist.refusal.recently_contacted': 'Contattata di recente, quindi viene saltata.',
  'assist.refusal.backend_unreachable': 'Impossibile raggiungere il backend di Pitchbox.',
  'assist.refusal.selector_health_degraded':
    'Il layout di LinkedIn è cambiato e Pitchbox non è riuscito a leggere questo post in modo affidabile.',
  'assist.refusal.generation_failed':
    'Qualcosa è andato storto durante la scrittura del suggerimento.',
  'assist.refusal.unknown': "L'assistente ha rifiutato questa richiesta ({reason}).",

  // Language names are endonyms, see the comment in dict-en.ts.
  'settings.language.option.en': 'English',
  'settings.language.option.it': 'Italiano',
} satisfies Record<keyof typeof en, string>;
