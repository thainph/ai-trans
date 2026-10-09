import { parseThreadLink } from '../../core/permalink';
import {
  DEFAULT_OPTIONS,
  EXPORT_PORT_NAME,
  type ExportAction,
  type ExportOptions,
  type ExportRequest,
  type ExportResponse,
} from '../../types/messages';
import { DEVDY_TARGET, type DevdyCommand, type DevdyStatus } from '../../types/devdy';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const linkInput = $<HTMLInputElement>('link');
const exportBtn = $<HTMLButtonElement>('export');
const copyBtn = $<HTMLButtonElement>('copy');
const optReactions = $<HTMLInputElement>('opt-reactions');
const optFiles = $<HTMLInputElement>('opt-files');
const optZip = $<HTMLInputElement>('opt-zip');
const devdySendBtn = $<HTMLButtonElement>('devdy-send');
const devdyPanel = $<HTMLDetailsElement>('devdy-panel');
const devdyDot = $<HTMLSpanElement>('devdy-dot');
const devdySummary = $<HTMLSpanElement>('devdy-summary');
const devdyPending = $<HTMLSpanElement>('devdy-pending');
const devdyToken = $<HTMLInputElement>('devdy-token');
const devdyTokenSave = $<HTMLButtonElement>('devdy-token-save');
const devdyDetail = $<HTMLSpanElement>('devdy-detail');
const devdyRetry = $<HTMLButtonElement>('devdy-retry');
const statusEl = $<HTMLParagraphElement>('status');
const errorEl = $<HTMLParagraphElement>('error');

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setError(text: string | null): void {
  errorEl.hidden = !text;
  errorEl.textContent = text ?? '';
}

function setBusy(busy: boolean): void {
  exportBtn.disabled = busy;
  copyBtn.disabled = busy;
  devdySendBtn.disabled = busy;
  linkInput.disabled = busy;
}

function currentOptions(): ExportOptions {
  return { includeReactions: optReactions.checked, includeFiles: optFiles.checked, zipFiles: optZip.checked };
}

/** "Zip files" only makes sense when files are included. */
function syncZipAvailability(): void {
  optZip.disabled = !optFiles.checked;
  optZip.closest('.chip')?.classList.toggle('disabled', optZip.disabled);
}

async function loadOptions(): Promise<void> {
  const stored = (await chrome.storage.sync.get(DEFAULT_OPTIONS)) as ExportOptions;
  optReactions.checked = stored.includeReactions;
  optFiles.checked = stored.includeFiles;
  optZip.checked = stored.zipFiles;
  syncZipAvailability();
}

function saveOptions(): void {
  void chrome.storage.sync.set(currentOptions());
}

/** Prefill the input when the active tab is showing a Slack thread. */
async function prefillFromActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url || linkInput.value) return;
    if (parseThreadLink(url).ok) {
      linkInput.value = url;
      setStatus('Prefilled from the open Slack thread.');
    }
  } catch {
    // Prefill is best effort only.
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for when the async clipboard API is unavailable.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Clipboard write failed');
  }
}

function filesSummary(files?: { saved: number; notIncluded: number }): string {
  if (!files) return '';
  return (
    `, ${files.saved} file${files.saved === 1 ? '' : 's'}` +
    (files.notIncluded ? `, ${files.notIncluded} not included` : '')
  );
}

// ---------------------------------------------------------------------------
// Devdy
// ---------------------------------------------------------------------------

function devdyCall<T>(req: DevdyCommand): Promise<T> {
  return chrome.runtime.sendMessage({ target: DEVDY_TARGET, ...req }) as Promise<T>;
}

function renderDevdy(st: DevdyStatus): void {
  let dot = '';
  let summary: string;
  if (!st.connected) {
    summary = 'Devdy · not running';
  } else if (!st.hasToken) {
    dot = 'warn';
    summary = 'Devdy · token needed';
  } else if (st.tokenValid === false) {
    dot = 'error';
    summary = 'Devdy · invalid token';
  } else {
    dot = 'ok';
    summary = `Devdy · connected${st.version ? ` (v${st.version})` : ''}`;
  }
  devdyDot.className = `dot ${dot}`.trim();
  devdySummary.textContent = summary;
  devdyPending.hidden = st.pending === 0;
  devdyPending.textContent = `${st.pending} queued`;
  devdyRetry.hidden = st.pending === 0;
  devdyToken.placeholder = st.hasToken ? 'Saved — paste a new one to replace' : 'Devdy → Settings → Inbox API';

  devdyDetail.textContent = st.error
    ? st.error
    : st.connected
      ? `127.0.0.1:${st.port}`
      : 'Start Devdy to send threads. Exports are queued meanwhile.';

  // Open the panel when something needs the user's attention.
  if (!st.hasToken || st.tokenValid === false) devdyPanel.open = true;
}

async function refreshDevdy(): Promise<void> {
  try {
    renderDevdy(await devdyCall<DevdyStatus>({ type: 'status' }));
  } catch {
    devdySummary.textContent = 'Devdy · status unavailable';
  }
}

function showDevdyResult(
  d: { kind: string; message: string; pending: number },
  files: { saved: number; notIncluded: number } | undefined,
  messageCount: number,
): void {
  const counts = `(${messageCount} messages${filesSummary(files)})`;
  if (d.kind === 'created' || d.kind === 'updated') {
    setStatus(`${d.message} ${counts}`);
  } else if (d.kind === 'unreachable' || d.kind === 'server_error') {
    setStatus(`${d.message} ${counts}`);
  } else {
    setStatus('');
    setError(d.message);
    if (d.kind === 'unauthorized' || d.kind === 'no_token') {
      devdyPanel.open = true;
      devdyToken.focus();
    }
  }
  void refreshDevdy();
}

devdyTokenSave.addEventListener('click', async () => {
  const token = devdyToken.value.trim();
  if (!token) {
    devdyToken.focus();
    return;
  }
  devdyTokenSave.disabled = true;
  try {
    const st = await devdyCall<DevdyStatus>({ type: 'save-token', token });
    devdyToken.value = '';
    renderDevdy(st);
    setError(st.tokenValid === false ? 'Devdy rejected this token.' : null);
    if (st.flushed) setStatus(`Sent ${st.flushed} queued export${st.flushed === 1 ? '' : 's'} to Devdy.`);
    else if (st.tokenValid) setStatus('Devdy token saved.');
  } finally {
    devdyTokenSave.disabled = false;
  }
});
devdyToken.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') devdyTokenSave.click();
});
devdyRetry.addEventListener('click', async () => {
  devdyRetry.disabled = true;
  try {
    const r = await devdyCall<{ sent: number; pending: number; status: DevdyStatus }>({ type: 'flush' });
    renderDevdy(r.status);
    setStatus(r.sent ? `Sent ${r.sent} queued export(s) to Devdy.` : 'Devdy is still not reachable.');
  } finally {
    devdyRetry.disabled = false;
  }
});

function startExport(action: ExportAction): void {
  setError(null);
  const link = linkInput.value.trim();
  const parsed = parseThreadLink(link);
  if (!parsed.ok) {
    setStatus('');
    setError(parsed.error.message);
    return;
  }

  setBusy(true);
  setStatus('Starting…');

  const port = chrome.runtime.connect({ name: EXPORT_PORT_NAME });
  let finished = false;
  const finish = () => {
    finished = true;
    setBusy(false);
    port.disconnect();
  };

  port.onMessage.addListener((msg: ExportResponse) => {
    if (msg.type === 'progress') {
      setStatus(msg.text);
    } else if (msg.type === 'error') {
      setStatus('');
      setError(msg.message);
      finish();
    } else if (msg.type === 'done') {
      if (msg.warning) setError(`Warning: ${msg.warning}`);
      if (msg.action === 'copy') {
        copyToClipboard(msg.markdown)
          .then(() => setStatus(`Copied ${msg.messageCount} messages to the clipboard.`))
          .catch((e: unknown) => setError(`Could not copy: ${e instanceof Error ? e.message : String(e)}`))
          .finally(finish);
      } else if (msg.action === 'devdy') {
        showDevdyResult(msg.devdy, msg.files, msg.messageCount);
        finish();
      } else {
        setStatus(`Saved ${msg.filename} (${msg.messageCount} messages${filesSummary(msg.files)}).`);
        finish();
      }
    }
  });
  port.onDisconnect.addListener(() => {
    if (!finished) {
      setBusy(false);
      setError('Lost connection to the extension background. Please try again.');
    }
  });

  const request: ExportRequest = { type: 'export', link, action, options: currentOptions() };
  port.postMessage(request);
}

exportBtn.addEventListener('click', () => startExport('download'));
copyBtn.addEventListener('click', () => startExport('copy'));
devdySendBtn.addEventListener('click', () => startExport('devdy'));
linkInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startExport('download');
});
optReactions.addEventListener('change', saveOptions);
optFiles.addEventListener('change', () => {
  syncZipAvailability();
  saveOptions();
});
optZip.addEventListener('change', saveOptions);

void loadOptions();
void prefillFromActiveTab();
void refreshDevdy();
linkInput.focus();
