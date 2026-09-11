import type { Dict } from './types.js';

/**
 * Glossary decisions, recorded in `docs/design/DECISIONS.md`: "draft"
 * translates to "bozza" and "campaign" to "campagna" (ordinary Italian
 * business nouns), while "run", "Inbox" and "Dashboard" stay in English, the
 * way an Italian founder actually talks about them in this kind of product.
 */
export const it = {
  'auth.disabled-title': 'Autenticazione disattivata',
  'auth.disabled-seo-title': 'Autenticazione disattivata',
  'auth.go-to-app': 'Vai a Pitchbox',

  'login.seo-title': 'Accedi',
  'login.seo-description': 'Accedi a Pitchbox',
  'login.disabled-body':
    "Questa istanza gira con PITCHBOX_AUTH disattivato, quindi non c'è nessun account a cui accedere. Imposta PITCHBOX_AUTH=on nel tuo ambiente per attivare l'accesso.",
  'login.create-first-user-title': 'Crea il primo utente',
  'login.sign-in-title': 'Accedi a Pitchbox',
  'login.first-user-hint':
    "Non esiste ancora nessun utente. Le credenziali che inserisci qui sotto creeranno l'account amministratore.",
  'login.username-label': 'Username',
  'login.password-label': 'Password',
  'login.create-button': 'Crea',
  'login.sign-in-button': 'Accedi',
  'login.need-account': 'Non hai un account?',
  'login.create-account-link': 'Creane uno',
  'login.forgot-password-link': 'Hai dimenticato la password?',
  'login.error-create-failed': "Impossibile creare l'utente",
  'login.error-invalid-credentials': 'Credenziali non valide',

  'register.seo-title': 'Crea un account',
  'register.seo-description': 'Crea un account Pitchbox',
  'register.disabled-body':
    "Questa istanza gira con PITCHBOX_AUTH disattivato, quindi non c'è nessun account da creare. Imposta PITCHBOX_AUTH=on nel tuo ambiente per attivare la registrazione.",
  'register.closed-title': 'Registrazione disattivata',
  'register.invite-only-title': 'Questa installazione è solo su invito',
  'register.closed-body':
    'La registrazione è disattivata su questa installazione. Chiedi un account a chi la gestisce.',
  'register.invite-only-body':
    "Questa installazione è solo su invito. Chiedi il link di invito a un owner dell'organizzazione per creare un account.",
  'register.sign-in-instead-button': 'Accedi invece',
  'register.title': 'Crea un account',
  'register.invited-body': 'Sei stato invitato a unirti a {org}. Crea un account per accettare.',
  'register.default-org': "un'organizzazione",
  'register.plan-body':
    "Stai continuando verso {plan} ({interval}) dopo la creazione dell'account.",
  'register.billed-annually': 'fatturazione annuale',
  'register.billed-monthly': 'fatturazione mensile',
  'register.email-label': 'Email',
  'register.already-have-account': 'Hai già un account?',
  'register.sign-in-link': 'Accedi',
  'register.error-username-taken': 'Questo username è già in uso',
  'register.error-email-taken': 'Questa email è già registrata',
  'register.error-invite-invalid': 'Questo invito non è più valido',
  'register.error-rate-limited': 'Troppi tentativi, riprova tra poco',
  'register.error-generic': "Impossibile creare l'account",
  'register.success-title': 'Account creato',
  'register.success-verify-body':
    'Controlla la tua email per verificare il tuo indirizzo prima di poter avviare un run.',
  'register.creating-button': 'Creazione…',
  'register.create-account-button': 'Crea account',

  'invite.invalid-title': 'Invito non valido o scaduto',
  'invite.invalid-body':
    "Chiedi all'amministratore dell'organizzazione di generare un nuovo link di invito.",
  'invite.title': 'Sei stato invitato',
  'invite.invited-by-body': '{inviter} ti ha invitato a unirti a {org}.',
  'invite.invited-generic-body': 'Sei stato invitato a unirti a {org}.',
  'invite.default-org': 'questa organizzazione',
  'invite.accept-button': "Accetta l'invito",
  'invite.accepting-button': 'Accettazione…',

  'reset.seo-title': 'Reimposta la password',
  'reset.seo-description': 'Richiedi un link per reimpostare la password',
  'reset.disabled-body':
    "Questa istanza gira con PITCHBOX_AUTH disattivato, quindi non c'è nessun account per cui reimpostare la password. Imposta PITCHBOX_AUTH=on nel tuo ambiente per attivarlo.",
  'reset.sent-title': 'Controlla la tua email',
  'reset.sent-body':
    "Se quell'indirizzo ha un account Pitchbox, un link di reset è in arrivo. Scade tra 20 minuti.",
  'reset.back-to-sign-in': "Torna all'accesso",
  'reset.title': 'Reimposta la password',
  'reset.body':
    "Inserisci l'email del tuo account e ti invieremo un link per scegliere una nuova password.",
  'reset.email-label': 'Email',
  'reset.send-button': 'Invia link di reset',
  'reset.sending-button': 'Invio in corso…',
  'reset.error-too-many-attempts': 'Troppi tentativi',
  'reset.error-retry-in': 'Riprova tra {seconds}s',
  'reset.error-send-failed': 'Impossibile inviare il link di reset',

  'reset.confirm.seo-title': 'Scegli una nuova password',
  'reset.confirm.seo-description': 'Scegli una nuova password Pitchbox',
  'reset.confirm.title': 'Scegli una nuova password',
  'reset.confirm.body':
    'Almeno 8 caratteri. Questo ti farà accedere e disconnetterà ogni altra sessione su questo account.',
  'reset.confirm.new-password-label': 'Nuova password',
  'reset.confirm.confirm-password-label': 'Conferma la nuova password',
  'reset.confirm.submit-button': 'Reimposta password',
  'reset.confirm.submitting-button': 'Reimpostazione…',
  'reset.confirm.success-title': 'Password reimpostata',
  'reset.confirm.success-body': 'Ogni altra sessione sul tuo account è stata disconnessa.',
  'reset.confirm.error-invalid-title': 'Questo link non è più valido',
  'reset.confirm.error-invalid-body':
    'Potrebbe essere scaduto o già stato usato, richiedine uno nuovo.',

  'brand.name': 'Pitchbox',

  'nav.aria-primary': 'Navigazione principale',
  'nav.aria-open': 'Apri la navigazione',
  'nav.aria-close': 'Chiudi la navigazione',
  'nav.home': 'Home',
  'nav.inbox': 'Inbox',
  'nav.group-outreach': 'Outreach',
  'nav.projects': 'Progetti',
  'nav.campaigns': 'Campagne',
  'nav.playbooks': 'Playbook',
  'nav.group-people': 'Persone',
  'nav.people': 'Persone',
  'nav.blocklist': 'Blocklist',
  'nav.group-insight': 'Insight',
  'nav.analytics': 'Analytics',
  'nav.audit': 'Audit',
  'nav.group-assistant': 'Assistente',
  'nav.companion': 'Companion',
  'nav.notifications': 'Notifiche',
  'nav.settings': 'Impostazioni',
  'nav.website': 'Sito web',
  'nav.docs': 'Documentazione',
  'nav.sign-out': 'Esci',
  'nav.error-refresh-count': 'Impossibile aggiornare il conteggio delle notifiche',
  'nav.error-refresh-count-offline':
    'Impossibile aggiornare il conteggio delle notifiche, controlla la connessione',
  'nav.error-sign-out': 'Impossibile uscire. Riprova.',
  'nav.error-sign-out-offline': 'Impossibile uscire, controlla la connessione.',

  'org-switcher.label': 'Organizzazione',
  'org-switcher.organizations-label': 'Organizzazioni',
  'org-switcher.organization-link': 'Organizzazione',
  'org-switcher.create-link': "Crea un'organizzazione",
  'org-switcher.create-description':
    'Dai un nome al tuo nuovo workspace. Potrai invitare altre persone in seguito.',
  'org-switcher.name-label': 'Nome',
  'org-switcher.url-prefix': 'URL:',
  'org-switcher.cancel': 'Annulla',
  'org-switcher.create-button': 'Crea',
  'org-switcher.error-switch': "Impossibile cambiare organizzazione",
  'org-switcher.error-slug-taken': 'Questo URL è già in uso, scegli un altro nome',
  'org-switcher.error-invalid-name': 'Inserisci un nome valido (almeno 3 lettere o numeri)',
  'org-switcher.error-create-generic': "Impossibile creare l'organizzazione",
  'org-switcher.success-created': 'Creata {name}',

  'command-palette.placeholder': 'Cerca bozze, contatti, campagne, progetti...',
  'command-palette.action-create-campaign': 'Crea campagna',
  'command-palette.action-generate-token': 'Genera token per l\'extension',
  'command-palette.action-open-settings': 'Apri le impostazioni',
  'command-palette.heading-actions': 'Azioni',
  'command-palette.searching': 'Ricerca in corso...',
  'command-palette.no-results': 'Nessun risultato trovato.',
  'command-palette.error-unavailable': 'La ricerca non è al momento disponibile.',
  'command-palette.error-rejected': 'La richiesta di ricerca è stata rifiutata.',
  'command-palette.error-unavailable-offline':
    'La ricerca non è al momento disponibile, controlla la connessione.',
  'command-palette.heading-drafts': 'Bozze',
  'command-palette.heading-contacts': 'Contatti',
  'command-palette.heading-campaigns': 'Campagne',
  'command-palette.heading-projects': 'Progetti',

  'billing-banner.read-only-title': 'Account in sola lettura dal {date}',
  'billing-banner.read-only-body':
    "Un pagamento non è andato a buon fine e nulla è riuscito durante il periodo di grazia, quindi nuovi run, suggerimenti, accettazioni, progetti, campagne, inviti e dispositivi vengono rifiutati. Tutto quello che è già qui resta leggibile - correggi il metodo di pagamento nel {link} per ripristinare il servizio.",
  'billing-banner.customer-portal-link': 'portale clienti',
  'billing-banner.grace-title': 'Pagamento non riuscito - periodo di grazia fino al {date}',
  'billing-banner.grace-body':
    'Il tuo piano continua a funzionare normalmente fino ad allora. Aggiorna il metodo di pagamento nel {link} prima del {date} per evitare che l\'account passi in sola lettura.',

  'chat-sync-banner.title': 'Sync di Reddit Chat in pausa',
  'chat-sync-banner.body':
    "Il token Matrix dell'estensione del browser non è più accettato. Apri {link} e ricarica la pagina in modo che l'estensione possa catturare un token nuovo. I nuovi messaggi in arrivo non appariranno fino ad allora.",

  'extension-nudge.no-device-title': "Rileva le risposte più in fretta con l'estensione del browser",
  'extension-nudge.no-device-body':
    "Nessuna estensione del browser è ancora abbinata a questo workspace. Installala e abbina un dispositivo da Impostazioni > Estensione browser così le risposte Reddit in arrivo compaiono qui automaticamente.",
  'extension-nudge.stale-title': 'La tua estensione del browser è silenziosa',
  'extension-nudge.stale-body':
    "Nessun dispositivo abbinato ha dato notizie da un po'. Apri Reddit nel browser in cui è installata, oppure abbina un nuovo dispositivo da Impostazioni > Estensione browser, per continuare a ricevere le risposte.",
  'extension-nudge.dismiss': 'Ignora',

  'onboarding-banner.aria-label': 'Configurazione',
  'onboarding-banner.title': 'Completa la configurazione di Pitchbox',
  'onboarding-banner.progress-count': '{done} di {total} completati',
  'onboarding-banner.next-label': 'Prossimo passo: {step}.',
  'onboarding-banner.continue-setup': 'Continua la configurazione',
  'onboarding-banner.skip': 'Salta per ora',
  'onboarding-banner.aria-progress': 'Avanzamento configurazione',

  'onboarding.step.organization.title': 'Dai un nome alla tua organizzazione',
  'onboarding.step.organization.description':
    "All'inizio prende il nome del tuo account. Dalle il nome che il tuo team o la tua azienda usano davvero.",
  'onboarding.step.organization.cta': 'Rinomina organizzazione',
  'onboarding.step.verify_email.title': 'Verifica il tuo indirizzo email',
  'onboarding.step.verify_email.description':
    "Conferma l'indirizzo registrato prima di poter avviare un run.",
  'onboarding.step.verify_email.cta': 'Verifica email',
  'onboarding.step.project.title': 'Crea un progetto con una fonte',
  'onboarding.step.project.description':
    "Dai all'agente qualcosa su cui scrivere: una cartella, un repository o un sito web.",
  'onboarding.step.project.cta': 'Crea un progetto',
  'onboarding.step.account.title': 'Collega un account della piattaforma',
  'onboarding.step.account.description':
    "Aggiungi l'account Reddit, Hacker News o Mastodon da cui partirà l'outreach.",
  'onboarding.step.account.cta': 'Collega un account',
  'onboarding.step.extension.title': "Installa l'estensione del browser",
  'onboarding.step.extension.description':
    "Abbinala una volta sola e ti aiuterà a scrivere commenti e a rilevare le risposte su una pagina reale.",
  'onboarding.step.extension.cta': "Scarica l'estensione",
  'onboarding.step.first_draft.title': 'Ottieni una prima bozza',
  'onboarding.step.first_draft.description':
    "Avvia una campagna e lascia che l'agente produca qualcosa da rivedere.",
  'onboarding.step.first_draft.cta': 'Avvia una campagna',

  'onboarding.page.seo-title': 'Configura Pitchbox',
  'onboarding.page.seo-description':
    'Dai un nome alla tua organizzazione, collega un account e arriva alla tua prima bozza.',
  'onboarding.page.header-description':
    'Pochi passi per andare da un workspace vuoto alla tua prima bozza.',
  'onboarding.page.review-button': 'Rivedi',
  'onboarding.page.completed-title': 'Sei pronto',
  'onboarding.page.completed-body':
    "Ogni passo della configurazione è completo. Rifalla quando vuoi da Impostazioni se vuoi ripercorrerla.",
  'onboarding.page.go-to-dashboard': 'Vai alla dashboard',
  'onboarding.page.skipped-title': 'Configurazione saltata',
  'onboarding.page.skipped-body': 'Puoi ricominciarla quando vuoi, da qui o da Impostazioni.',
  'onboarding.page.start-again': 'Ricomincia la configurazione',

  'settings.onboarding.seo-title': 'Impostazioni - Onboarding',
  'settings.onboarding.seo-description':
    "La configurazione guidata iniziale: il suo stato e come ricominciarla.",
  'settings.onboarding.title': 'Onboarding',
  'settings.onboarding.description': 'La configurazione guidata avviata al primo accesso.',
  'settings.onboarding.status-label': 'Stato',
  'settings.onboarding.status.not-started': 'Non iniziata',
  'settings.onboarding.status.in-progress': 'In corso',
  'settings.onboarding.status.completed': 'Completata',
  'settings.onboarding.status.skipped': 'Saltata',
} satisfies Dict;
