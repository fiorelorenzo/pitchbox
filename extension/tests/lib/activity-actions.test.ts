import { describe, expect, it } from 'vitest';
import {
  resolveActivityAction,
  type ActivityAction,
  type ActivityEvent,
} from '../../src/lib/activity.js';

// #452: split out of #403, which shipped the sentence rendering but
// deliberately left an error row with nothing to click. This table proves
// resolveActivityAction() names exactly one action for the row kinds #452
// calls out (a sync failure, a revoked LinkedIn permission, a backend that
// answered an error, a refusal naming a setting) and stays silent for
// everything else - a DOM timing miss, a refusal naming a person, a device
// revocation that needs a fresh pairing code by hand. A pure function of the
// event plus the current LinkedIn-permission read, not the component: this
// is the whole decision, testable without mounting anything.
function ev(
  over: Partial<ActivityEvent> = {},
): Pick<ActivityEvent, 'level' | 'source' | 'message' | 'messageParams'> {
  return {
    level: 'error',
    source: 'system',
    message: 'activity.system.boot',
    messageParams: undefined,
    ...over,
  };
}

describe('resolveActivityAction', () => {
  const cases: Array<{
    name: string;
    event: Partial<ActivityEvent>;
    linkedInGranted: boolean;
    want: ActivityAction['kind'] | null;
  }> = [
    {
      name: 'a dm-sync poller failure offers a retry',
      event: { level: 'error', source: 'dm-sync', message: 'activity.dm-sync.error' },
      linkedInGranted: true,
      want: 'retry-sync',
    },
    {
      name: 'a chat-sync poller failure offers a retry',
      event: { level: 'error', source: 'chat-sync', message: 'activity.chat-sync.error' },
      linkedInGranted: true,
      want: 'retry-sync',
    },
    {
      name: 'a stale reddit.com session offers opening reddit.com',
      event: { level: 'warn', source: 'dm-sync', message: 'activity.dm-sync.unauthorized' },
      linkedInGranted: true,
      want: 'open-reddit',
    },
    {
      name: 'an expired Matrix token offers opening reddit.com',
      event: { level: 'warn', source: 'chat-sync', message: 'activity.chat-sync.unauthorized' },
      linkedInGranted: true,
      want: 'open-reddit',
    },
    {
      name: 'a device revocation gets no button (needs a fresh pairing code by hand)',
      event: { level: 'warn', source: 'dm-sync', message: 'activity.dm-sync.device-revoked' },
      linkedInGranted: true,
      want: null,
    },
    {
      name: "a reddit draft's backend flip failure offers opening the backend",
      event: {
        level: 'error',
        source: 'reddit-action',
        message: 'activity.reddit-action.fail',
        messageParams: { draftId: 1, reason: 'http 500' },
      },
      linkedInGranted: true,
      want: 'open-backend',
    },
    {
      name: "a linkedin draft's backend flip failure offers opening the backend",
      event: {
        level: 'error',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.fail',
        messageParams: { draftId: 1, reason: 'http 500' },
      },
      linkedInGranted: true,
      want: 'open-backend',
    },
    {
      name: 'a reddit DOM timing miss gets no button (page may already be closed)',
      event: {
        level: 'warn',
        source: 'reddit-action',
        message: 'activity.reddit-action.comment-box-missing',
        messageParams: { draftId: 1 },
      },
      linkedInGranted: true,
      want: null,
    },
    {
      name: 'assist refused by the kill switch offers opening assist settings',
      event: {
        level: 'warn',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.suggestion-refused',
        messageParams: { reason: 'kill_switch' },
      },
      linkedInGranted: true,
      want: 'open-assist-settings',
    },
    {
      name: 'assist refused because it is off offers opening assist settings',
      event: {
        level: 'warn',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.suggestion-refused',
        messageParams: { reason: 'assist_disabled' },
      },
      linkedInGranted: true,
      want: 'open-assist-settings',
    },
    {
      name: 'assist refused on quota offers opening assist settings',
      event: {
        level: 'warn',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.suggestion-refused',
        messageParams: { reason: 'quota_exhausted' },
      },
      linkedInGranted: true,
      want: 'open-assist-settings',
    },
    {
      name: 'assist unreachable offers opening the backend, not settings',
      event: {
        level: 'warn',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.suggestion-refused',
        messageParams: { reason: 'backend_unreachable' },
      },
      linkedInGranted: true,
      want: 'open-backend',
    },
    {
      name: 'assist refused for an uncontactable person gets no button',
      event: {
        level: 'warn',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.suggestion-refused',
        messageParams: { reason: 'uncontactable' },
      },
      linkedInGranted: true,
      want: null,
    },
    {
      name: 'assist refused for a reason this client does not recognise gets no button',
      event: {
        level: 'warn',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.suggestion-refused',
        messageParams: { reason: 'something_new' },
      },
      linkedInGranted: true,
      want: null,
    },
    {
      name: 'the passive collector stopped by the kill switch offers opening assist settings',
      event: {
        level: 'warn',
        source: 'linkedin-collector',
        message: 'activity.linkedin-collector.stopped',
        messageParams: { reason: 'kill_switch' },
      },
      linkedInGranted: true,
      want: 'open-assist-settings',
    },
    {
      name: 'the passive collector stopped for an unparsed reason gets no button',
      event: {
        level: 'warn',
        source: 'linkedin-collector',
        message: 'activity.linkedin-collector.stopped',
        messageParams: { reason: 'refused' },
      },
      linkedInGranted: true,
      want: null,
    },
    {
      name: 'a LinkedIn-sourced row with access currently off offers turning it back on, overriding any reason-specific mapping',
      event: {
        level: 'warn',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.suggestion-refused',
        messageParams: { reason: 'kill_switch' },
      },
      linkedInGranted: false,
      want: 'regrant-linkedin-access',
    },
    {
      name: 'a LinkedIn DOM selector miss with access off offers turning it back on',
      event: {
        level: 'warn',
        source: 'linkedin-dom',
        message: 'activity.linkedin-dom.selector-miss',
        messageParams: { selector: '.foo', pageKind: 'feed', misses: 3, matches: 0 },
      },
      linkedInGranted: false,
      want: 'regrant-linkedin-access',
    },
    {
      name: 'a LinkedIn DOM selector miss with access on gets no button (a layout drift, not a setting)',
      event: {
        level: 'warn',
        source: 'linkedin-dom',
        message: 'activity.linkedin-dom.selector-miss',
        messageParams: { selector: '.foo', pageKind: 'feed', misses: 3, matches: 0 },
      },
      linkedInGranted: true,
      want: null,
    },
    {
      name: 'a non-LinkedIn source is unaffected by LinkedIn access being off',
      event: { level: 'error', source: 'dm-sync', message: 'activity.dm-sync.error' },
      linkedInGranted: false,
      want: 'retry-sync',
    },
    {
      name: 'an info-level row never gets a button, whatever its message',
      event: { level: 'info', source: 'dm-sync', message: 'activity.dm-sync.error' },
      linkedInGranted: true,
      want: null,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const action = resolveActivityAction(ev(c.event), { linkedInGranted: c.linkedInGranted });
      expect(action?.kind ?? null).toBe(c.want);
    });
  }
});
