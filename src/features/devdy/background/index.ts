// Devdy integration (service worker side): the Slack link queue, its retry
// alarm, the migration of the old outbox and the small message API the Devdy
// tab uses for settings/status.

import { fail, ok, onTargetMessage } from '../../../shared/messaging';
import { fromExtensionPage } from '../../../shared/sender';
import {
  findAllDevdy,
  isDevdyPort,
  listProjects,
  postSlackThread,
  resolveDevdy,
  resolveFromInstances,
  supportsGrammar,
  supportsSlackThreadLink,
  supportsTranslate,
} from '../core/client';
import { migrateLegacyOutbox } from '../core/migration';
import { DevdyOutbox, type DevdySettings, type OutboxState, type QueuedLink } from '../core/outbox';
import { DEVDY_TARGET, type DevdyFlushResult, type DevdyRequest, type DevdyStatus } from '../messages';

export const KEYS = {
  token: 'devdyToken',
  port: 'devdyPort',
  pinned: 'devdyPortPinned',
  /** Queued Slack thread links (QueuedLink[]). */
  queue: 'devdyLinkQueue',
  /** Queue retry state (OutboxState: paused, backoff, notice). */
  queueState: 'devdyLinkQueueState',
} as const;
const RETRY_ALARM = 'devdy-outbox-retry';

/** Token and instance choice (Devdy tab). */
export async function loadSettings(): Promise<DevdySettings> {
  const s = await chrome.storage.local.get([KEYS.token, KEYS.port, KEYS.pinned]);
  return {
    token: typeof s[KEYS.token] === 'string' && s[KEYS.token] ? (s[KEYS.token] as string) : undefined,
    port: typeof s[KEYS.port] === 'number' ? (s[KEYS.port] as number) : undefined,
    pinned: s[KEYS.pinned] === true,
  };
}

async function loadState(): Promise<OutboxState> {
  const s = await chrome.storage.local.get(KEYS.queueState);
  const v = s[KEYS.queueState];
  return v && typeof v === 'object' ? (v as OutboxState) : {};
}

export const outbox = new DevdyOutbox({
  loadEntries: async () => {
    const s = await chrome.storage.local.get(KEYS.queue);
    const list = s[KEYS.queue];
    return Array.isArray(list) ? (list as QueuedLink[]).filter((e) => typeof e?.url === 'string') : [];
  },
  saveEntries: (entries) => chrome.storage.local.set({ [KEYS.queue]: entries }),
  loadState,
  saveState: (state) => chrome.storage.local.set({ [KEYS.queueState]: state }),
  loadSettings,
  savePort: (port) => chrome.storage.local.set({ [KEYS.port]: port }),
  resolveDevdy: (settings) => resolveDevdy(settings),
  postSlackThread: (port, token, url) => postSlackThread(port, token, url),
  scheduleRetry: async (minutes) => {
    // One-shot alarm: the queue picks the next delay (backoff) after each attempt.
    if (minutes === null) await chrome.alarms.clear(RETRY_ALARM);
    else await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: minutes });
  },
});

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** Drop the blob outbox of AI Trans ≤ 2.1 (storage keys + IndexedDB); guarded by `devdyLegacyMigrated`. */
function migrate(): Promise<number> {
  return migrateLegacyOutbox({
    getLocal: (keys) => chrome.storage.local.get([...keys]),
    removeLocal: (keys) => chrome.storage.local.remove([...keys]),
    setLocal: (items) => chrome.storage.local.set(items),
    deleteDatabase,
    setNotice: (text) => outbox.setNotice(text),
  });
}

/**
 * Connection, features, token and queue for the Devdy tab. With `deliver`, links
 * still queued are sent right away when the app can take them (e.g. Devdy was
 * just updated to a build with "slack-thread-link"), instead of waiting for the
 * next backoff step (up to 60 min); `flushed` then says how many went out.
 */
async function status(deliver = false): Promise<DevdyStatus> {
  const settings = await loadSettings();
  // Lock-free reads: the status never waits behind a send in progress.
  const [queue, state, all] = await Promise.all([outbox.entries(), loadState(), findAllDevdy()]);
  const instances = all.map((i) => ({ port: i.port, version: i.health.version }));
  const resolved = resolveFromInstances(all, settings);
  const base = {
    hasToken: !!settings.token,
    queue: queue.map(({ id, url, createdAt, attempts, lastError }) => ({ id, url, createdAt, attempts, lastError })),
    paused: !!state.paused,
    notice: state.notice,
    instances,
    pinned: !!settings.pinned,
    features: { translate: false, grammar: false, slackThreadLink: false },
  };

  if (resolved.kind === 'none') {
    return { ...base, connected: false, port: settings.pinned ? settings.port : undefined };
  }
  if (resolved.kind === 'ambiguous') {
    return { ...base, connected: false, needsInstanceChoice: true };
  }
  const { port, health } = resolved.instance;
  if (port !== settings.port) await chrome.storage.local.set({ [KEYS.port]: port });
  const connected = {
    ...base,
    connected: true,
    port,
    version: health.version,
    features: {
      translate: supportsTranslate(health),
      grammar: supportsGrammar(health),
      slackThreadLink: supportsSlackThreadLink(health),
    },
  };
  if (!settings.token) return connected;
  const res = await listProjects(port, settings.token);
  if (res.ok) {
    if (deliver && connected.features.slackThreadLink && queue.length > 0) {
      const { sent } = await outbox.flush();
      return { ...(await status()), flushed: sent };
    }
    return { ...connected, tokenValid: true };
  }
  return {
    ...connected,
    tokenValid: res.kind === 'unauthorized' ? false : undefined,
    error: res.kind === 'unauthorized' ? 'Devdy rejected the token.' : res.message,
  };
}

async function handle(msg: DevdyRequest): Promise<DevdyStatus | DevdyFlushResult> {
  switch (msg.type) {
    case 'status':
      return status(true);
    case 'save-token': {
      const token = typeof msg.token === 'string' ? msg.token.trim() : '';
      await chrome.storage.local.set({ [KEYS.token]: token });
      // A new/fixed token may unblock queued links: resume retries and send them now.
      await outbox.resume();
      const flushed = token ? (await outbox.flush()).sent : 0;
      return { ...(await status()), flushed };
    }
    case 'select-instance': {
      // null = automatic (only valid while a single Devdy is running).
      if (msg.port === null) await chrome.storage.local.set({ [KEYS.pinned]: false });
      else if (isDevdyPort(msg.port)) await chrome.storage.local.set({ [KEYS.port]: msg.port, [KEYS.pinned]: true });
      else throw new Error('Invalid Devdy port.');
      const flushed = (await outbox.flush()).sent;
      return { ...(await status()), flushed };
    }
    case 'flush': {
      const r = await outbox.flush();
      return { sent: r.sent, pending: r.pending, status: await status() };
    }
    case 'remove':
      await outbox.remove(String(msg.id));
      return status();
    case 'clear-notice':
      await outbox.clearNotice();
      return status();
  }
}

onTargetMessage<DevdyRequest>(DEVDY_TARGET, (msg, sender) => {
  // Token, instance and queue commands: only the Devdy tab (extension pages).
  if (!fromExtensionPage(sender)) return fail(new Error('Not allowed.'));
  return handle(msg).then(ok, fail);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void outbox.flush({ auto: true });
});
chrome.runtime.onStartup.addListener(() => void outbox.flush({ auto: true }));
chrome.runtime.onInstalled.addListener(() => void migrate());
