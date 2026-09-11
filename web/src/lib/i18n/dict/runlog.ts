/**
 * `runlog.*` - RunLog.svelte and everything under components/runlog/ (LOR-263
 * part two). The 8 event-kind and per-tool-call status labels themselves
 * already resolve through `badge.event-kind.*` / `badge.tool-call-status.*`
 * / `badge.run-live-status.*` (status-badges.ts, part one) - this module is
 * the prose around them: the status bar, the empty states, and each event
 * row's own copy.
 *
 * `describeEnvelopeData` (parse.ts) explains why several keys here are
 * `tn()` plurals even where the English wording barely moves: Italian past
 * participles agree in number ("1 candidato recuperato" vs "3 candidati
 * recuperati"), which a single interpolated string cannot express.
 */
import type { Dict } from '../types.js';

export const runlogEn = {
  'runlog.listening': 'Listening for runs…',
  'runlog.events-count.one': '{n} event',
  'runlog.events-count.other': '{n} events',
  'runlog.reconnected': 'Reconnected. Log refreshed in case any events were missed.',
  'runlog.stream-disconnected': 'Live updates disconnected. Refresh the page to resume.',
  'runlog.stream-reconnecting':
    'Live updates interrupted, reconnecting… new events may be delayed.',
  'runlog.waiting-first-event': 'Waiting for the first event…',
  'runlog.no-events-for-run': 'No events recorded for run #{runId}.',
  'runlog.predates-persistence': 'This run may pre-date event persistence.',
  'runlog.idle-hint': 'Idle - start a run to see events here.',
  'runlog.jump-to-latest': 'Jump to latest',
  'runlog.load-error-server': 'Could not load the run log. Please try again.',
  'runlog.load-error-generic': 'Could not load the run log.',
  'runlog.load-error-network': 'Could not load the run log, check your connection.',

  'runlog.expand': 'expand',
  'runlog.collapse': 'collapse',

  'runlog.show-less': 'Show less',
  'runlog.show-more': 'Show more',

  'runlog.rate-limit-ok': 'rate limit ok',

  'runlog.run-succeeded': 'Run succeeded',
  'runlog.run-failed': 'Run failed',
  'runlog.tokens': '{input} → {output} tokens',
  'runlog.turns-count.one': '{n} turn',
  'runlog.turns-count.other': '{n} turns',

  'runlog.todos-inline': '{completed}/{total} done',
  'runlog.todos-completed': '{completed}/{total} completed',

  'runlog.launching-skill': 'Launching {skill}',
  'runlog.status-running': 'running',
  'runlog.status-ok': 'ok',
  'runlog.status-error': 'error',
  'runlog.status-exit': 'exit {code}',
  'runlog.command-failed': 'Command failed',
  'runlog.error-label': 'Error',
  'runlog.aria-copy-command': 'Copy command',
  'runlog.input-label': 'Input',
  'runlog.output-label': 'Output',
  'runlog.no-input-parameters': 'No input parameters',
  'runlog.todos-updated': 'Todos updated.',

  'runlog.event-prefix': 'event: {type}',

  'runlog.envelope-items.one': '{n} item',
  'runlog.envelope-items.other': '{n} items',
  'runlog.envelope-run-started': 'run #{runId} started',
  'runlog.envelope-project': 'project {project}',
  'runlog.envelope-accounts.one': '{n} account',
  'runlog.envelope-accounts.other': '{n} accounts',
  'runlog.envelope-contacted.one': '{n} contacted',
  'runlog.envelope-contacted.other': '{n} contacted',
  'runlog.envelope-candidates-fetched.one': '{n} candidate fetched',
  'runlog.envelope-candidates-fetched.other': '{n} candidates fetched',
  'runlog.envelope-drafts-created.one': '{n} draft created',
  'runlog.envelope-drafts-created.other': '{n} drafts created',
  'runlog.envelope-staged-candidates.one': '{n} staged candidate',
  'runlog.envelope-staged-candidates.other': '{n} staged candidates',
} satisfies Dict;

export const runlogIt = {
  'runlog.listening': 'In ascolto di run…',
  'runlog.events-count.one': '{n} evento',
  'runlog.events-count.other': '{n} eventi',
  'runlog.reconnected': 'Riconnesso. Log aggiornato nel caso siano stati persi eventi.',
  'runlog.stream-disconnected':
    'Aggiornamenti live disconnessi. Aggiorna la pagina per riprendere.',
  'runlog.stream-reconnecting':
    'Aggiornamenti live interrotti, riconnessione in corso… i nuovi eventi potrebbero arrivare in ritardo.',
  'runlog.waiting-first-event': 'In attesa del primo evento…',
  'runlog.no-events-for-run': 'Nessun evento registrato per la run #{runId}.',
  'runlog.predates-persistence':
    'Questa run potrebbe essere precedente alla persistenza degli eventi.',
  'runlog.idle-hint': 'Inattivo: avvia una run per vedere gli eventi qui.',
  'runlog.jump-to-latest': 'Vai agli ultimi',
  'runlog.load-error-server': 'Impossibile caricare il log della run. Riprova.',
  'runlog.load-error-generic': 'Impossibile caricare il log della run.',
  'runlog.load-error-network': 'Impossibile caricare il log della run, controlla la connessione.',

  'runlog.expand': 'espandi',
  'runlog.collapse': 'comprimi',

  'runlog.show-less': 'Mostra meno',
  'runlog.show-more': 'Mostra altro',

  'runlog.rate-limit-ok': 'limite di frequenza ok',

  'runlog.run-succeeded': 'Run riuscita',
  'runlog.run-failed': 'Run fallita',
  'runlog.tokens': '{input} → {output} token',
  'runlog.turns-count.one': '{n} turno',
  'runlog.turns-count.other': '{n} turni',

  'runlog.todos-inline': '{completed}/{total} fatti',
  'runlog.todos-completed': '{completed}/{total} completati',

  'runlog.launching-skill': 'Avvio di {skill}',
  'runlog.status-running': 'in corso',
  'runlog.status-ok': 'ok',
  'runlog.status-error': 'errore',
  'runlog.status-exit': 'uscita {code}',
  'runlog.command-failed': 'Comando non riuscito',
  'runlog.aria-copy-command': 'Copia il comando',
  'runlog.error-label': 'Errore',
  'runlog.input-label': 'Input',
  'runlog.output-label': 'Output',
  'runlog.no-input-parameters': 'Nessun parametro di input',
  'runlog.todos-updated': 'Todo aggiornati.',

  'runlog.event-prefix': 'evento: {type}',

  'runlog.envelope-items.one': '{n} elemento',
  'runlog.envelope-items.other': '{n} elementi',
  'runlog.envelope-run-started': 'run #{runId} avviata',
  'runlog.envelope-project': 'progetto {project}',
  'runlog.envelope-accounts.one': '{n} account',
  'runlog.envelope-accounts.other': '{n} account',
  'runlog.envelope-contacted.one': '{n} contattato',
  'runlog.envelope-contacted.other': '{n} contattati',
  'runlog.envelope-candidates-fetched.one': '{n} candidato recuperato',
  'runlog.envelope-candidates-fetched.other': '{n} candidati recuperati',
  'runlog.envelope-drafts-created.one': '{n} bozza creata',
  'runlog.envelope-drafts-created.other': '{n} bozze create',
  'runlog.envelope-staged-candidates.one': '{n} candidato in coda',
  'runlog.envelope-staged-candidates.other': '{n} candidati in coda',
} satisfies Dict;
