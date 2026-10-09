// Devdy integration (service worker side): outbox wiring, retry alarm and the
// small message API the Slack popup uses for settings/status.

import { deleteBlob, getBlob, putBlob } from '../core/blob-store';
import { findDevdy, listProjects, postThread } from '../core/devdy-client';
import { type DevdySettings, DevdyOutbox, type OutboxEntry } from '../core/devdy-outbox';
import { DEVDY_TARGET, type DevdyRequest, type DevdyStatus } from '../types/devdy';

const KEYS = {
  token: 'devdyToken',
  port: 'devdyPort',
  projectId: 'devdyProjectId',
  outbox: 'devdyOutbox',
} as const;
const RETRY_ALARM = 'devdy-outbox-retry';

async function loadSettings(): Promise<DevdySettings> {
  const s = await chrome.storage.local.get([KEYS.token, KEYS.port, KEYS.projectId]);
  return {
    token: typeof s[KEYS.token] === 'string' && s[KEYS.token] ? (s[KEYS.token] as string) : undefined,
    port: typeof s[KEYS.port] === 'number' ? (s[KEYS.port] as number) : undefined,
    projectId: typeof s[KEYS.projectId] === 'string' && s[KEYS.projectId] ? (s[KEYS.projectId] as string) : undefined,
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
  findDevdy: (preferred) => findDevdy(preferred),
  postThread: (port, token, payload) => postThread(port, token, payload),
  setRetryAlarm: async (on) => {
    if (on) {
      if (!(await chrome.alarms.get(RETRY_ALARM))) await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    } else {
      await chrome.alarms.clear(RETRY_ALARM);
    }
  },
});

export { loadSettings as loadDevdySettings };

async function status(): Promise<DevdyStatus> {
  const settings = await loadSettings();
  const pending = (await outbox.pending()).length;
  const found = await findDevdy(settings.port);
  if (!found) {
    return { connected: false, hasToken: !!settings.token, projectId: settings.projectId, pending, projects: [] };
  }
  if (found.port !== settings.port) await chrome.storage.local.set({ [KEYS.port]: found.port });
  const base = {
    connected: true,
    port: found.port,
    version: found.health.version,
    hasToken: !!settings.token,
    projectId: settings.projectId,
    pending,
  };
  if (!settings.token) return { ...base, projects: [] };
  const res = await listProjects(found.port, settings.token);
  if (res.ok) return { ...base, tokenValid: true, projects: res.projects };
  return {
    ...base,
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
    case 'set-project':
      await chrome.storage.local.set({ [KEYS.projectId]: msg.projectId ?? '' });
      return { ok: true };
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
