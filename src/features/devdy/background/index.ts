// Devdy integration (service worker side): outbox wiring, retry alarm and the
// small message API the Devdy tab uses for settings/status.

import { fail, ok, onTargetMessage } from '../../../shared/messaging';
import { deleteBlob, getBlob, listBlobIds, putBlob } from '../core/blob-store';
import {
  findAllDevdy,
  isDevdyPort,
  listProjects,
  postCapture,
  resolveDevdy,
  resolveFromInstances,
} from '../core/client';
import { DevdyOutbox, type DevdySettings, isQueued, type OutboxEntry, type OutboxState } from '../core/outbox';
import { DEVDY_TARGET, type DevdyFlushResult, type DevdyRequest, type DevdyStatus } from '../messages';
import { fromExtension } from './sender';

const KEYS = {
  token: 'devdyToken',
  port: 'devdyPort',
  pinned: 'devdyPortPinned',
  outbox: 'devdyOutbox',
  outboxState: 'devdyOutboxState',
} as const;
const RETRY_ALARM = 'devdy-outbox-retry';

async function loadSettings(): Promise<DevdySettings> {
  const s = await chrome.storage.local.get([KEYS.token, KEYS.port, KEYS.pinned]);
  return {
    token: typeof s[KEYS.token] === 'string' && s[KEYS.token] ? (s[KEYS.token] as string) : undefined,
    port: typeof s[KEYS.port] === 'number' ? (s[KEYS.port] as number) : undefined,
    pinned: s[KEYS.pinned] === true,
  };
}

async function loadState(): Promise<OutboxState> {
  const s = await chrome.storage.local.get(KEYS.outboxState);
  const v = s[KEYS.outboxState];
  return v && typeof v === 'object' ? (v as OutboxState) : {};
}

export const outbox = new DevdyOutbox({
  loadEntries: async () => {
    const s = await chrome.storage.local.get(KEYS.outbox);
    return Array.isArray(s[KEYS.outbox]) ? (s[KEYS.outbox] as OutboxEntry[]) : [];
  },
  saveEntries: (entries) => chrome.storage.local.set({ [KEYS.outbox]: entries }),
  loadState,
  saveState: (state) => chrome.storage.local.set({ [KEYS.outboxState]: state }),
  loadSettings,
  savePort: (port) => chrome.storage.local.set({ [KEYS.port]: port }),
  putBlob,
  getBlob,
  deleteBlob,
  listBlobIds,
  resolveDevdy: (settings) => resolveDevdy(settings),
  postCapture: (port, token, payload) => postCapture(port, token, payload),
  scheduleRetry: async (minutes) => {
    // One-shot alarm: the outbox picks the next delay (backoff) after each attempt.
    if (minutes === null) await chrome.alarms.clear(RETRY_ALARM);
    else await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: minutes });
  },
});

async function status(): Promise<DevdyStatus> {
  const settings = await loadSettings();
  // Lock-free reads: the status never waits behind an upload in progress.
  const [entries, state, all] = await Promise.all([outbox.entries(), loadState(), findAllDevdy()]);
  const instances = all.map((i) => ({ port: i.port, version: i.health.version }));
  const resolved = resolveFromInstances(all, settings);
  const base = {
    hasToken: !!settings.token,
    pending: entries.filter(isQueued).length,
    failed: entries
      .filter((e) => e.failed)
      .map((e) => ({
        id: e.id,
        title: e.title,
        contentType: e.contentType,
        size: e.size,
        message: e.failed!.message,
        at: e.failed!.at,
      })),
    paused: !!state.paused,
    notice: state.notice,
    instances,
    pinned: !!settings.pinned,
  };

  if (resolved.kind === 'none') {
    return { ...base, connected: false, port: settings.pinned ? settings.port : undefined, projects: [] };
  }
  if (resolved.kind === 'ambiguous') {
    return { ...base, connected: false, needsInstanceChoice: true, projects: [] };
  }
  const { port, health } = resolved.instance;
  if (port !== settings.port) await chrome.storage.local.set({ [KEYS.port]: port });
  const connected = { ...base, connected: true, port, version: health.version };
  if (!settings.token) return { ...connected, projects: [] };
  const res = await listProjects(port, settings.token);
  if (res.ok) return { ...connected, tokenValid: true, projects: res.projects };
  return {
    ...connected,
    tokenValid: res.kind === 'unauthorized' ? false : undefined,
    projects: [],
    error: res.kind === 'unauthorized' ? 'Devdy rejected the token.' : res.message,
  };
}

async function handle(msg: DevdyRequest): Promise<DevdyStatus | DevdyFlushResult> {
  switch (msg.type) {
    case 'status':
      return status();
    case 'save-token': {
      const token = typeof msg.token === 'string' ? msg.token.trim() : '';
      await chrome.storage.local.set({ [KEYS.token]: token });
      // A new/fixed token may unblock queued exports: resume retries and send them now.
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
    case 'remove-failed':
      await outbox.remove(String(msg.id));
      return status();
    case 'clear-notice':
      await outbox.clearNotice();
      return status();
  }
}

onTargetMessage<DevdyRequest>(DEVDY_TARGET, (msg, sender) => {
  // Token, instance and queue commands: only the Devdy tab (extension pages).
  if (!fromExtension(sender)) return fail(new Error('Not allowed.'));
  return handle(msg).then(ok, fail);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void outbox.flush({ auto: true });
});
chrome.runtime.onStartup.addListener(() => void outbox.flush({ auto: true }));
// Blobs written by store-zip but never enqueued (SW killed in between).
chrome.runtime.onInstalled.addListener(() => void outbox.cleanup());
