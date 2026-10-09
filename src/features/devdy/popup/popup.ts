// Devdy tab: connection status, app (port) choice, token and outbox queue.

import { errorMessage } from '../../../shared/errors';
import { safeFileName } from '../../../shared/filename';
import type { Result } from '../../../shared/messaging';
import { getBlob } from '../core/blob-store';
import {
  DEVDY_TARGET,
  type DevdyCommand,
  type DevdyFlushResult,
  type DevdyStatus,
  type FailedExport,
} from '../messages';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const dot = $<HTMLSpanElement>('dot');
const summary = $<HTMLSpanElement>('summary');
const detail = $<HTMLDivElement>('detail');
const refreshBtn = $<HTMLButtonElement>('refresh');
const instanceSection = $<HTMLDivElement>('instance-section');
const instanceSelect = $<HTMLSelectElement>('instance');
const instanceHint = $<HTMLParagraphElement>('instance-hint');
const tokenInput = $<HTMLInputElement>('token');
const tokenSave = $<HTMLButtonElement>('token-save');
const queueSection = $<HTMLDivElement>('queue-section');
const queueText = $<HTMLSpanElement>('queue');
const retryBtn = $<HTMLButtonElement>('retry');
const failedSection = $<HTMLDivElement>('failed-section');
const failedList = $<HTMLUListElement>('failed');
const noticeSection = $<HTMLDivElement>('notice-section');
const noticeText = $<HTMLSpanElement>('notice');
const noticeClear = $<HTMLButtonElement>('notice-clear');
const statusEl = $<HTMLParagraphElement>('status');
const errorEl = $<HTMLParagraphElement>('error');

const AUTO = 'auto';

async function call<T extends object>(req: DevdyCommand): Promise<T> {
  const res = (await chrome.runtime.sendMessage({ target: DEVDY_TARGET, ...req })) as Result<T> | undefined;
  if (!res) throw new Error('No response from the extension background.');
  if (!res.ok) throw new Error(res.error);
  return res;
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setError(text: string | null): void {
  errorEl.hidden = !text;
  errorEl.textContent = text ?? '';
}

function render(st: DevdyStatus): void {
  let cls = '';
  let text: string;
  let info = '';
  if (st.needsInstanceChoice) {
    cls = 'warn';
    text = 'Choose a Devdy app';
    info = `${st.instances.length} Devdy apps are running — pick the one to send to below.`;
  } else if (!st.connected) {
    text = 'Devdy is not running';
    info =
      st.pinned && st.port
        ? `The selected app (port ${st.port}) is not answering. Exports are queued meanwhile.`
        : 'Start Devdy to send. Exports are queued meanwhile.';
  } else if (!st.hasToken) {
    cls = 'warn';
    text = 'Token needed';
    info = 'Paste the token from Devdy → Settings → Inbox API.';
  } else if (st.tokenValid === false) {
    cls = 'error';
    text = 'Invalid token';
    info = 'Devdy rejected the token. Paste it again from Devdy → Settings → Inbox API.';
  } else {
    cls = 'ok';
    text = `Connected${st.version ? ` · v${st.version}` : ''}`;
    info = st.error ?? `127.0.0.1:${st.port}${st.pinned ? ' (selected)' : ''}`;
  }
  dot.className = `dot ${cls}`.trim();
  summary.textContent = text;
  detail.textContent = info;

  // App picker: needed when several Devdy apps run, or one was pinned before.
  const showPicker = st.instances.length > 1 || st.pinned;
  instanceSection.hidden = !showPicker;
  if (showPicker) {
    instanceSelect.replaceChildren();
    if (st.instances.length <= 1) instanceSelect.add(new Option('Automatic', AUTO));
    else instanceSelect.add(new Option('— Choose an app —', AUTO));
    for (const i of st.instances) {
      instanceSelect.add(new Option(`Port ${i.port}${i.version ? ` · v${i.version}` : ''}`, String(i.port)));
    }
    if (st.pinned && st.port && !st.instances.some((i) => i.port === st.port)) {
      instanceSelect.add(new Option(`Port ${st.port} (not running)`, String(st.port)));
    }
    instanceSelect.value = st.pinned && st.port ? String(st.port) : AUTO;
    instanceHint.textContent =
      st.instances.length > 1
        ? 'e.g. a production and a dev build. Exports go only to the selected app.'
        : 'Only the selected app receives exports.';
  }

  tokenInput.placeholder = st.hasToken ? 'Saved — paste a new one to replace' : 'Devdy → Settings → Inbox API';
  queueSection.hidden = st.pending === 0;
  queueText.textContent =
    `${st.pending} export${st.pending === 1 ? '' : 's'} waiting to be sent` +
    (st.paused && st.pending ? ' — paused until a valid token is saved' : '');

  failedSection.hidden = st.failed.length === 0;
  failedList.replaceChildren(...st.failed.map(failedItem));
  noticeSection.hidden = !st.notice;
  noticeText.textContent = st.notice ?? '';
}

function formatSize(n?: number): string {
  if (!n) return '';
  return n < 1024 * 1024 ? ` · ${Math.ceil(n / 1024)} KB` : ` · ${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadName(f: FailedExport): string {
  const ext = f.contentType.startsWith('application/zip') ? 'zip' : 'md';
  return `${safeFileName(f.title.replace(/\.(md|zip)$/i, ''), 80)}.${ext}`;
}

/** Save a failed export's payload (read straight from the outbox IndexedDB). */
async function downloadFailed(f: FailedExport): Promise<void> {
  const blob = await getBlob(f.id);
  if (!blob) throw new Error('The export data is no longer stored.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName(f);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function failedItem(f: FailedExport): HTMLLIElement {
  const li = document.createElement('li');
  const title = document.createElement('div');
  title.className = 'failed-title';
  title.textContent = f.title;
  const info = document.createElement('div');
  info.className = 'muted-text';
  info.textContent = `${f.message}${formatSize(f.size)}`;
  const row = document.createElement('div');
  row.className = 'btn-row';
  const dl = document.createElement('button');
  dl.type = 'button';
  dl.className = 'link-btn';
  dl.textContent = 'Download';
  dl.addEventListener('click', () => {
    downloadFailed(f).catch((e: unknown) => setError(errorMessage(e)));
  });
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'link-btn';
  rm.textContent = 'Remove';
  rm.addEventListener('click', async () => {
    rm.disabled = true;
    try {
      render(await call<DevdyStatus>({ type: 'remove-failed', id: f.id }));
    } catch (e) {
      setError(errorMessage(e));
      rm.disabled = false;
    }
  });
  row.append(dl, rm);
  li.append(title, info, row);
  return li;
}

async function refresh(): Promise<DevdyStatus | undefined> {
  refreshBtn.disabled = true;
  try {
    const st = await call<DevdyStatus>({ type: 'status' });
    render(st);
    return st;
  } catch (e) {
    summary.textContent = 'Status unavailable';
    detail.textContent = errorMessage(e);
    return undefined;
  } finally {
    refreshBtn.disabled = false;
  }
}

function flushedNote(n?: number): void {
  if (n) setStatus(`Sent ${n} queued export${n === 1 ? '' : 's'} to Devdy.`);
}

tokenSave.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    tokenInput.focus();
    return;
  }
  tokenSave.disabled = true;
  try {
    const st = await call<DevdyStatus>({ type: 'save-token', token });
    tokenInput.value = '';
    render(st);
    setError(st.tokenValid === false ? 'Devdy rejected this token.' : null);
    if (st.flushed) flushedNote(st.flushed);
    else setStatus('Token saved.');
  } finally {
    tokenSave.disabled = false;
  }
});
tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tokenSave.click();
});

instanceSelect.addEventListener('change', async () => {
  const port = instanceSelect.value === AUTO ? null : Number(instanceSelect.value);
  const st = await call<DevdyStatus>({ type: 'select-instance', port });
  render(st);
  setStatus(port ? `Exports now go to the Devdy app on port ${port}.` : 'Automatic app selection.');
  flushedNote(st.flushed);
});

retryBtn.addEventListener('click', async () => {
  retryBtn.disabled = true;
  try {
    const r = await call<DevdyFlushResult>({ type: 'flush' });
    render(r.status);
    setStatus(r.sent ? `Sent ${r.sent} queued export${r.sent === 1 ? '' : 's'} to Devdy.` : 'Still waiting for Devdy.');
  } finally {
    retryBtn.disabled = false;
  }
});

refreshBtn.addEventListener('click', () => void refresh());

noticeClear.addEventListener('click', async () => {
  render(await call<DevdyStatus>({ type: 'clear-notice' }));
});

// Opening the tab is a good moment to deliver queued exports (Devdy may be up again).
void refresh().then(async (st) => {
  if (!st?.pending || !st.connected) return;
  const r = await call<DevdyFlushResult>({ type: 'flush' }).catch(() => undefined);
  if (!r) return;
  render(r.status);
  flushedNote(r.sent);
});
