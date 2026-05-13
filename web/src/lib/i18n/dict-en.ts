import type { Dict } from './types';

// English dictionary - source of truth. Other locales mirror these keys.
export const en: Dict = {
  // Sidebar navigation
  'nav.home': 'Home',
  'nav.inbox': 'Inbox',
  'nav.projects': 'Projects',
  'nav.campaigns': 'Campaigns',
  'nav.contacts': 'Contacts',
  'nav.conversations': 'Conversations',
  'nav.blocklist': 'Blocklist',
  'nav.playbooks': 'Playbooks',
  'nav.notifications': 'Notifications',
  'nav.analytics': 'Analytics',
  'nav.audit': 'Audit',
  'nav.settings': 'Settings',
  'nav.docs': 'Docs',
  'nav.signOut': 'Sign out',
  'nav.signIn': 'Sign in',
  'nav.daemon': 'Daemon',
  'nav.daemon.online': 'online',
  'nav.daemon.offline': 'offline',

  // System status footer
  'status.liveStream': 'Live stream',
  'status.live': 'live',
  'status.reconnecting': 'reconnecting',
  'status.connecting': 'connecting',
  'status.offline': 'offline',
  'status.checking': 'checking',

  // Inbox header
  'inbox.title': 'Inbox',
  'inbox.empty': 'No drafts to review',

  // Settings header
  'settings.title': 'Settings',
  'settings.appearance.title': 'Appearance',
  'settings.appearance.locale.label': 'Language',
  'settings.appearance.locale.help':
    'Interface language. English is the default; Italian is a seed translation.',
  'settings.appearance.theme.label': 'Theme',
  'settings.appearance.theme.help': 'Follow system or pick light or dark explicitly.',

  // Login page
  'login.title': 'Sign in',
  'login.submit': 'Sign in',
};
