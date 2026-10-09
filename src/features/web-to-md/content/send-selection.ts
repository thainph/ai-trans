// Page content script (all sites, all frames): "Send selection to Devdy" for the
// translator's selection toolbar (➤ button), plus the result toast.

import { errorMessage } from '../../../shared/errors';
import { isExtensionAlive } from '../../../shared/runtime';
import { Toaster } from '../../../shared/toast';
import { htmlToMarkdown } from '../core/converter';
import { WEB_TARGET, WEB_TOAST_TARGET, type WebRequest, type WebToastMessage } from '../messages';
import { pageMeta, selectionHtml } from './selection';

/** blob: images only exist in this page; inline small ones so Devdy gets them. */
export const MAX_INLINE_BLOB_BYTES = 5 * 1024 * 1024;
/** All inlined blob: images together (base64 adds ~33% to the message). */
export const MAX_INLINE_TOTAL_BYTES = 10 * 1024 * 1024;

const toaster = new Toaster((action) => {
  if (action === 'open-settings' && isExtensionAlive()) {
    const req: WebRequest = { target: WEB_TARGET, type: 'open-settings' };
    void chrome.runtime.sendMessage(req).catch(() => {});
  }
}, 'context-kit-web-toast-host');

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Body as a Blob, or null as soon as it exceeds `max` bytes (never read whole). */
async function readCappedBlob(res: Response, max: number, type: string): Promise<Blob | null> {
  const declared = Number(res.headers.get('Content-Length'));
  if (res.headers.has('Content-Length') && Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) {
    const blob = await res.blob();
    return blob.size > max ? null : blob;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks as Uint8Array<ArrayBuffer>[], { type });
}

export interface InlineOptions {
  fetchFn?: typeof fetch;
  toDataUrl?: (blob: Blob) => Promise<string>;
  maxEach?: number;
  maxTotal?: number;
}

/**
 * Replace `src="blob:…"` images by data: URLs, each ≤ `maxEach` and together
 * ≤ `maxTotal`; sizes are checked before/while reading. Others stay blob: links.
 */
export async function inlineBlobImages(html: string, opts: InlineOptions = {}): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const toDataUrl = opts.toDataUrl ?? readDataUrl;
  const maxEach = opts.maxEach ?? MAX_INLINE_BLOB_BYTES;
  const maxTotal = opts.maxTotal ?? MAX_INLINE_TOTAL_BYTES;
  const blobUrls = [...new Set([...html.matchAll(/src="(blob:[^"]+)"/g)].map((m) => m[1]!))];
  let used = 0;
  for (const url of blobUrls) {
    const room = Math.min(maxEach, maxTotal - used);
    if (room <= 0) break;
    try {
      const res = await fetchFn(url);
      const type = (res.headers.get('Content-Type') ?? '').toLowerCase();
      if (!res.ok || !type.startsWith('image/')) {
        void res.body?.cancel().catch(() => {});
        continue;
      }
      const blob = await readCappedBlob(res, room, type);
      if (!blob) continue;
      used += blob.size;
      html = html.split(`src="${url}"`).join(`src="${await toDataUrl(blob)}"`);
    } catch {
      // keep the blob: URL (it will stay a link)
    }
  }
  return html;
}

export async function sendSelection(range: Range, text: string): Promise<void> {
  if (!isExtensionAlive()) {
    toaster.show({ key: 'reloaded', state: 'error', text: 'AI Trans was updated. Reload this page and try again.' });
    return;
  }
  const key = `local-${Date.now()}`;
  toaster.show({ key, state: 'progress', text: 'Preparing selection…' });
  try {
    const html = await inlineBlobImages(selectionHtml(range, location.href));
    const md = htmlToMarkdown(html, { keepImages: true, keepLinks: true, baseUrl: location.href });
    const req: WebRequest = {
      target: WEB_TARGET,
      type: 'send-selection',
      markdown: md.trim() ? md : text,
      selectionText: text,
      page: pageMeta(),
    };
    const res = (await chrome.runtime.sendMessage(req)) as { ok: boolean; error?: string } | undefined;
    if (res && !res.ok) throw new Error(res.error ?? 'rejected');
    toaster.dismiss(key); // the background's toast (same position) takes over
  } catch (e) {
    toaster.show({ key, state: 'error', text: `Could not send: ${errorMessage(e)}` });
  }
}

if (isExtensionAlive()) {
  chrome.runtime.onMessage.addListener((msg: WebToastMessage) => {
    if (msg?.target === WEB_TOAST_TARGET) toaster.show(msg);
  });
}
