import type { Dict } from './types.js';

// Italian translations for dict-en.ts. Same keys, same params, same
// actionability - a refusal that no longer tells the person what to do is a
// regression even when the translation itself is correct, so every sentence
// below keeps the original's concrete instruction (which link, which
// setting, which deadline) rather than shortening it into a generic apology.
export const it = {
  'api.runner_not_allowed': 'Il runner "{runner}" non è disponibile per questa installazione.',

  'api.register.registration_closed':
    'La registrazione è disabilitata su questa installazione. Chiedi un account a chi la gestisce.',
  'api.register.invite_required':
    "Questa installazione richiede un invito. Chiedi un link di invito a un amministratore dell'organizzazione.",

  'api.projects.custom_tone_required':
    'Descrivi il tono che vuoi, oppure scegli "Usa il valore predefinito dell\'organizzazione".',

  'api.uploads.multipart_parse_failed': 'lettura del file non riuscita',
  'api.uploads.too_many_files': 'massimo {max} file',
  'api.uploads.no_files': 'nessun file nella richiesta',
  'api.uploads.file_too_large': '{rel} supera il limite di {max}B per file',
  'api.uploads.total_too_large': 'il caricamento totale supera il limite di {max}B',
  'api.uploads.bad_path': 'percorso non valido "{rel}": {reason}',
  'api.uploads.reason.empty_path': 'percorso vuoto',
  'api.uploads.reason.absolute_path': 'percorso assoluto',
  'api.uploads.reason.invalid_characters': 'caratteri non validi',
  'api.uploads.reason.parent_traversal': 'tentativo di uscire dalla cartella',
  'api.uploads.reason.path_too_long': 'percorso troppo lungo',
  'api.uploads.no_allowed_files': 'nessun file consentito nel caricamento',
  'api.uploads.path_escaped_root': 'il percorso risolto esce dalla cartella di destinazione: {rel}',

  'mail.password_reset.subject': 'Reimposta la tua password Pitchbox',
  'mail.password_reset.body':
    'Qualcuno ha chiesto di reimpostare la password di questo account Pitchbox.\n\n' +
    'Apri questo link entro 20 minuti per sceglierne una nuova:\n{resetUrl}\n\n' +
    'Se non sei stato tu, ignora questo messaggio: la tua password resta invariata.',

  'mail.verify_email.subject': 'Verifica il tuo indirizzo email Pitchbox',
  'mail.verify_email.register_body':
    'Benvenuto su Pitchbox. Conferma questo indirizzo per iniziare a eseguire campagne.\n\n' +
    'Apri questo link entro 48 ore per verificarlo:\n{verifyUrl}\n\n' +
    'Puoi accedere e guardarti intorno prima di verificarlo: non potrai ancora avviare un run. ' +
    'Se non hai creato tu questo account, ignora questo messaggio.',
  'mail.verify_email.resend_body':
    'Conferma questo indirizzo per iniziare a eseguire campagne.\n\n' +
    'Apri questo link entro 48 ore per verificarlo:\n{verifyUrl}\n\n' +
    'Se non hai richiesto tu questa email, ignorala.',

  'mail.invite.subject': 'Sei stato invitato a unirti a {orgName} su Pitchbox',
  'mail.invite.body':
    'Sei stato invitato a unirti a {orgName} su Pitchbox come {role}.\n\n' +
    "Accetta l'invito: {url}\n\n" +
    'Questo invito scade il {expiresAt}. Se non te lo aspettavi, puoi ignorare questa email.',
} satisfies Dict;
