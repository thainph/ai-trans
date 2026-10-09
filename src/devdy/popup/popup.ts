// Devdy tab: connection status, app (port) choice, token and outbox queue.

import { DEVDY_TARGET, type DevdyCommand, type DevdyStatus } from '../../types/devdy';

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
const statusEl = $<HTMLParagraphElement>('status');
const errorEl = $<HTMLParagraphElement>('error');

const AUTO = 'auto';

function call<T>(req: DevdyCommand): Promise<T> {
  return chrome.runtime.sendMessage({ target: DEVDY_TARGET, ...req }) as Promise<T>;
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
    info = st.pinned && st.port
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
  queueText.textContent = `${st.pending} export${st.pending === 1 ? '' : 's'} waiting to be sent`;
}

async function refresh(): Promise<void> {
  refreshBtn.disabled = true;
  try {
    render(await call<DevdyStatus>({ type: 'status' }));
  } catch (e) {
    summary.textContent = 'Status unavailable';
    detail.textContent = e instanceof Error ? e.message : String(e);
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
    const r = await call<{ sent: number; pending: number; status: DevdyStatus }>({ type: 'flush' });
    render(r.status);
    setStatus(r.sent ? `Sent ${r.sent} queued export${r.sent === 1 ? '' : 's'} to Devdy.` : 'Still waiting for Devdy.');
  } finally {
    retryBtn.disabled = false;
  }
});

refreshBtn.addEventListener('click', () => void refresh());

void refresh();
