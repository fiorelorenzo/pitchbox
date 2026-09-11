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
} satisfies Dict;
