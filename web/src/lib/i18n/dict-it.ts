import type { Dict } from './types';

// Italian dictionary seed. Mirror the keys from `dict-en.ts`.
export const it: Dict = {
  // Sidebar navigation
  'nav.home': 'Home',
  'nav.inbox': 'Posta in arrivo',
  'nav.projects': 'Progetti',
  'nav.campaigns': 'Campagne',
  'nav.contacts': 'Contatti',
  'nav.conversations': 'Conversazioni',
  'nav.blocklist': 'Lista di blocco',
  'nav.playbooks': 'Playbook',
  'nav.notifications': 'Notifiche',
  'nav.settings': 'Impostazioni',
  'nav.docs': 'Documentazione',
  'nav.signOut': 'Esci',
  'nav.daemon': 'Daemon',
  'nav.daemon.online': 'online',
  'nav.daemon.offline': 'offline',

  // Inbox header
  'inbox.title': 'Posta in arrivo',
  'inbox.empty': 'Nessuna bozza da rivedere',

  // Settings header
  'settings.title': 'Impostazioni',
  'settings.appearance.title': 'Aspetto',
  'settings.appearance.locale.label': 'Lingua',
  'settings.appearance.locale.help':
    "Lingua dell'interfaccia. L'inglese è il valore predefinito; l'italiano è una traduzione iniziale.",

  // Login page
  'login.title': 'Accedi',
  'login.submit': 'Accedi',
};
