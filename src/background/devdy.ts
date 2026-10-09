// Devdy integration (service worker side): outbox wiring, retry alarm and the
// small message API the Devdy tab uses for settings/status.

import { deleteBlob, getBlob, putBlob } from '../core/blob-store';
import { findAllDevdy, listProjects, postCapture, resolveDevdy } from '../core/devdy-client';
import { type DevdySettings, DevdyOutbox, type OutboxEntry } from '../core/devdy-outbox';
import { DEVDY_TARGET, type DevdyRequest, type DevdyStatus } from '../types/devdy';

const KEYS = {
  token: 'devdyToken',
  port: 'devdyPort',
  pinned: 'devdyPortPinned',
  outbox: 'devdyOutbox',
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

export const outbox = new DevdyOutbox({
  loadEntries: async () => {
    const s = await chrome.storage.local.get(KEYS.outbox);
    return Array.isArray(s[KEYS.outbox]) ? (s[KEYS.outbox] as OutboxEntry[]) : [];
  },
  saveEntries: (entries) => chrome.storage.local.set({ [KEYS.outbox]: entries }),
  loadSettings,
  savePort: (port) => chrome.storage.local.set({ [KEYS.port]: port }),
  putBlob,
  getBlob,
  deleteBlob,
  resolveDevdy: (settings) => resolveDevdy(settings),
  postCapture: (port, token, payload) => postCapture(port, token, payload),
  setRetryAlarm: async (on) => {
    if (on) {
      if (!(await chrome.alarms.get(RETRY_ALARM))) await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    } else {
      await chrome.alarms.clear(RETRY_ALARM);
    }
  },
});

async function status(): Promise<DevdyStatus> {
  const settings = await loadSettings();
  const pending = (await outbox.pending()).length;
  const all = await findAllDevdy();
  const instances = all.map((i) => ({ port: i.port, version: i.health.version }));
  const resolved = await resolveDevdy(settings);
  const base = { hasToken: !!settings.token, pending, instances, pinned: !!settings.pinned };

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

async function handle(msg: DevdyRequest): Promise<unknown> {
  switch (msg.type) {
    case 'status':
      return status();
    case 'save-token': {
      const token = msg.token.trim();
      await chrome.storage.local.set({ [KEYS.token]: token });
      // A new/fixed token may unblock queued exports: send them now.
      const flushed = token ? (await outbox.flush()).sent : 0;
      return { ...(await status()), flushed };
    }
    case 'select-instance': {
      // null = automatic (only valid while a single Devdy is running).
      if (msg.port === null) await chrome.storage.local.set({ [KEYS.pinned]: false });
      else await chrome.storage.local.set({ [KEYS.port]: msg.port, [KEYS.pinned]: true });
      const flushed = (await outbox.flush()).sent;
      return { ...(await status()), flushed };
    }
    case 'flush': {
      const r = await outbox.flush();
      return { ...r, status: await status() };
    }
  }
}

chrome.runtime.onMessage.addListener((msg: DevdyRequest, _sender, sendResponse) => {
  if (msg?.target !== DEVDY_TARGET) return;
  handle(msg).then(sendResponse, (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void outbox.flush();
});
chrome.runtime.onStartup.addListener(() => void outbox.flush());
