// Web → MD tab: extract the active page (all frames), convert it to Markdown,
// then export (.md or .zip with images), copy, or send it to Devdy.

import { errorMessage } from '../../../shared/errors';
import { filenamePart } from '../../../shared/filename';
import { htmlToMarkdown } from '../core/converter';
import { type ExtractMode, type ExtractResult, extractInPage } from '../core/extract';
import { type PageMeta, webFrontMatter } from '../core/web-capture';
import { type DownloadPageResponse, type SendPageResponse, WEB_TARGET, type WebRequest } from '../messages';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const statusEl = $<HTMLDivElement>('status');
const previewEl = $<HTMLPreElement>('preview');
const modeSelect = $<HTMLSelectElement>('mode');
const frontmatterOpt = $<HTMLInputElement>('frontmatter');
const keepImagesOpt = $<HTMLInputElement>('keepImages');
const keepLinksOpt = $<HTMLInputElement>('keepLinks');
const downloadBtn = $<HTMLButtonElement>('download');
const copyBtn = $<HTMLButtonElement>('copy');
const devdyBtn = $<HTMLButtonElement>('devdy');
const openDevdyBtn = $<HTMLButtonElement>('openDevdy');
const openContentBtn = $<HTMLButtonElement>('openContent');

/** What "Send to Devdy" posts (body without the local front matter). */
let lastCapture: Omit<Extract<WebRequest, { type: 'send-page' }>, 'target' | 'type'> | null = null;
let lastFilename = 'page.md';

function setStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

function offerOpenContent(url: string): void {
  openContentBtn.hidden = false;
  openContentBtn.onclick = () => chrome.tabs.create({ url });
}
function hideOpenContent(): void {
  openContentBtn.hidden = true;
}

async function generate(): Promise<string | null> {
  setStatus('Reading page…');
  hideOpenContent();
  const mode = modeSelect.value as ExtractMode;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab found.', true);
    return null;
  }
  if (/^(chrome|edge|about|chrome-extension|https:\/\/chrome\.google\.com\/webstore)/.test(tab.url || '')) {
    setStatus("Can't run on browser system pages.", true);
    return null;
  }

  // Pass 1: every frame (the page + its iframes, e.g. a Claude artifact) reports
  // its metadata and text length only — no HTML over IPC yet.
  let frames: { frameId: number; data: ExtractResult }[];
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractInPage,
      args: [mode, 'score'],
    });
    frames = (injection || [])
      .filter((r) => typeof r?.result?.textLen === 'number')
      .map((r) => ({ frameId: r.frameId, data: r.result as ExtractResult }));
  } catch (e) {
    setStatus(`Injection error: ${errorMessage(e)}`, true);
    return null;
  }

  if (!frames.length) {
    setStatus('Could not extract any content.', true);
    return null;
  }

  // Metadata comes from the top frame first
  const topFrame = frames.find((f) => f.data.isTop) || frames[0]!;
  // Content: the frame with the most text (an artifact iframe beats its shell page)
  const bestFrame = frames.reduce((a, b) => (b.data.textLen > a.data.textLen ? b : a), frames[0]!);
  const top = topFrame.data.meta;
  const bestMeta = bestFrame.data.meta;
  const uchost = topFrame.data.uchost;

  // Claude artifact: only the (nearly empty) shell was readable, but the content host is known
  const looksEmpty = bestFrame.data.textLen < 40;
  if (looksEmpty && uchost) {
    const contentUrl = `https://${uchost}${location.search}`;
    offerOpenContent(contentUrl);
    setStatus(
      "The artifact content is inside an iframe that can't be read. Click the button below to open the content page, then convert it.",
      true,
    );
    return null;
  }

  if (looksEmpty) {
    setStatus(
      mode === 'selection'
        ? 'No text is selected.'
        : 'Could not extract any content (wait for the page to finish loading and try again).',
      true,
    );
    return null;
  }

  // Pass 2: the HTML of the winning frame only.
  let best: ExtractResult | undefined;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [bestFrame.frameId] },
      func: extractInPage,
      args: [mode, 'content'],
    });
    best = res?.result as ExtractResult | undefined;
  } catch (e) {
    setStatus(`Injection error: ${errorMessage(e)}`, true);
    return null;
  }
  if (!best?.html) {
    setStatus('Could not extract any content (the page changed; try again).', true);
    return null;
  }

  const fromIframe = bestFrame !== topFrame;
  const page: PageMeta = {
    url: top.url,
    pageTitle:
      bestFrame.data.textLen > topFrame.data.textLen && bestMeta.pageTitle
        ? bestMeta.pageTitle
        : top.pageTitle || bestMeta.pageTitle,
    siteName: top.siteName,
    author: top.author || bestMeta.author,
    description: top.description || bestMeta.description,
    publishedAt: top.publishedAt || bestMeta.publishedAt,
  };
  const title = page.pageTitle ?? '';

  const md = htmlToMarkdown(best.html, {
    keepImages: keepImagesOpt.checked,
    keepLinks: keepLinksOpt.checked,
    baseUrl: page.url,
  });

  const selection = mode === 'selection';

  let doc = '';
  if (frontmatterOpt.checked) doc += webFrontMatter(page, { selection, capturedAt: new Date() });
  doc += `# ${title}\n\n`;
  doc += md;

  lastFilename = `${filenamePart(title, 'page')}.md`;
  lastCapture = {
    // Selection: just the excerpt (Devdy titles it from its first line).
    markdown: selection ? md : `# ${title}\n\n${md}`,
    selection,
    selectionText: selection ? best.text || '' : undefined,
    page,
  };

  previewEl.textContent = doc.length > 4000 ? `${doc.slice(0, 4000)}\n… (preview truncated)` : doc;
  previewEl.classList.remove('muted');
  const src = fromIframe ? ` · from iframe (1 of ${frames.length} frames)` : '';
  setStatus(`Done · ${doc.length.toLocaleString('en-US')} chars · ~${Math.ceil(doc.length / 4)} tokens${src}.`);
  return doc;
}

downloadBtn.addEventListener('click', async () => {
  const doc = await generate();
  if (!doc) return;

  // Images in the Markdown → a .zip (<name>.md + images/) like the Slack export.
  let note = '';
  if (keepImagesOpt.checked) {
    downloadBtn.disabled = true;
    setStatus('Downloading images…');
    try {
      const req: WebRequest = {
        target: WEB_TARGET,
        type: 'download-page',
        markdown: doc,
        filename: lastFilename,
        pageUrl: lastCapture?.page.url,
      };
      const res = (await chrome.runtime.sendMessage(req)) as DownloadPageResponse | undefined;
      if (res?.ok && res.zipped) {
        const kept = res.images.failed ? `, ${res.images.failed} kept as links` : '';
        setStatus(`Saved ${res.filename} (${res.images.saved} image${res.images.saved === 1 ? '' : 's'}${kept})`);
        return;
      }
      if (res?.ok && res.images.failed) note = ` (${res.images.failed} image(s) could not be downloaded; links kept)`;
      if (res && !res.ok) note = ` (zip failed: ${res.error})`;
    } catch (e) {
      note = ` (zip failed: ${errorMessage(e)})`;
    } finally {
      downloadBtn.disabled = false;
    }
  }

  const blob = new Blob([doc], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: lastFilename, saveAs: true });
    setStatus(`Saved ${lastFilename}${note}`);
  } catch (e) {
    setStatus(`Download error: ${errorMessage(e)}`, true);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
});

copyBtn.addEventListener('click', async () => {
  const doc = await generate();
  if (!doc) return;
  try {
    await navigator.clipboard.writeText(doc);
    setStatus('Markdown copied to clipboard.');
  } catch (e) {
    setStatus(`Copy error: ${errorMessage(e)}`, true);
  }
});

// Send to Devdy (POST /v1/web-pages via the background outbox)
const NEEDS_SETTINGS = ['no_token', 'unauthorized', 'choose_instance'];
devdyBtn.addEventListener('click', async () => {
  const doc = await generate();
  if (!doc || !lastCapture) return;
  devdyBtn.disabled = true;
  setStatus('Sending to Devdy…');
  try {
    const req: WebRequest = { target: WEB_TARGET, type: 'send-page', ...lastCapture };
    const res = (await chrome.runtime.sendMessage(req)) as SendPageResponse | undefined;
    if (!res?.ok) {
      setStatus(`Could not send: ${(res && !res.ok && res.error) || 'no response'}`, true);
      return;
    }
    const kind = res.result.delivery.kind;
    setStatus(res.text, kind === 'rejected' || NEEDS_SETTINGS.includes(kind));
    openDevdyBtn.hidden = !NEEDS_SETTINGS.includes(kind);
  } catch (e) {
    setStatus(`Could not send: ${errorMessage(e)}`, true);
  } finally {
    devdyBtn.disabled = false;
  }
});
// Switch the popup shell to the Devdy tab (token / instance settings).
openDevdyBtn.addEventListener('click', () => {
  window.parent.postMessage({ type: 'context-kit-open-tab', tool: 'devdy' }, location.origin);
});

// Build the preview as soon as the tab opens.
void generate();
