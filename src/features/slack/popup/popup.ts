import { errorMessage } from '../../../shared/errors';
import { parseThreadLink } from '../core/permalink';
import {
  DEFAULT_OPTIONS,
  EXPORT_PORT_NAME,
  type ExportAction,
  type ExportOptions,
  type ExportRequest,
  type ExportResponse,
} from '../messages';

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
const openDevdyBtn = $<HTMLButtonElement>('open-devdy');
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

/** Outcomes the user fixes in the Devdy tab (token / which Devdy app). */
const NEEDS_SETTINGS = new Set(['no_token', 'unauthorized', 'choose_instance']);

function showDevdyResult(
  d: { kind: string; message: string; pending: number },
  files: { saved: number; notIncluded: number } | undefined,
  messageCount: number,
): void {
  const counts = `(${messageCount} messages${filesSummary(files)})`;
  openDevdyBtn.hidden = !NEEDS_SETTINGS.has(d.kind);
  if (d.kind === 'created' || d.kind === 'updated' || d.kind === 'unreachable' || d.kind === 'server_error') {
    setStatus(`${d.message} ${counts}`);
  } else {
    setStatus('');
    setError(d.message);
  }
}

// The popup shell hosts this page in an iframe: ask it to switch to the Devdy tab.
openDevdyBtn.addEventListener('click', () => {
  window.parent.postMessage({ type: 'context-kit-open-tab', tool: 'devdy' }, location.origin);
});

function startExport(action: ExportAction): void {
  setError(null);
  openDevdyBtn.hidden = true;
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
          .catch((e: unknown) => setError(`Could not copy: ${errorMessage(e)}`))
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
linkInput.focus();
