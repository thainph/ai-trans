// Page content script (all sites, all frames): "Send selection to Devdy" for the
// translator's selection toolbar (public/translator/content.js calls
// `window.__contextKitDevdy.sendSelection(range, text)`), plus the result toast.
//
// Loaded after web-to-md/converter.js (provides window.htmlToMarkdown) and
// before translator/content.js — all three share the extension's isolated world.

import { Toaster } from '../../content/toast';
import { WEB_TARGET, WEB_TOAST_TARGET, type WebRequest, type WebToastMessage } from '../../types/web';
import { pageMeta, selectionHtml } from './selection';

declare global {
  interface Window {
    htmlToMarkdown?: (html: string, opts: { keepImages: boolean; keepLinks: boolean; baseUrl: string }) => string;
    __contextKitDevdy?: { sendSelection(range: Range, text: string): void };
  }
}

/** blob: images only exist in this page; inline small ones so Devdy gets them. */
const MAX_INLINE_BLOB_BYTES = 5 * 1024 * 1024;

function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const toaster = new Toaster((action) => {
  if (action === 'open-settings' && alive()) {
    const req: WebRequest = { target: WEB_TARGET, type: 'open-settings' };
    void chrome.runtime.sendMessage(req).catch(() => {});
  }
}, 'context-kit-web-toast-host');

async function inlineBlobImages(html: string): Promise<string> {
  const blobUrls = [...new Set([...html.matchAll(/src="(blob:[^"]+)"/g)].map((m) => m[1]!))];
  for (const url of blobUrls) {
    try {
      const blob = await (await fetch(url)).blob();
      if (blob.size > MAX_INLINE_BLOB_BYTES || !blob.type.startsWith('image/')) continue;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      html = html.split(`src="${url}"`).join(`src="${dataUrl}"`);
    } catch {
      // keep the blob: URL (it will stay a link)
    }
  }
  return html;
}

async function sendSelection(range: Range, text: string): Promise<void> {
  if (!alive()) {
    toaster.show({ key: 'reloaded', state: 'error', text: 'Context Kit was updated. Reload this page and try again.' });
    return;
  }
  const key = 'local-' + Date.now();
  toaster.show({ key, state: 'progress', text: 'Preparing selection…' });
  try {
    const html = await inlineBlobImages(selectionHtml(range, location.href));
    const md = window.htmlToMarkdown?.(html, { keepImages: true, keepLinks: true, baseUrl: location.href }) ?? '';
    const req: WebRequest = {
      target: WEB_TARGET,
      type: 'send-selection',
      markdown: md.trim() ? md : text,
      selectionText: text,
      page: pageMeta(document, location.href),
    };
    await chrome.runtime.sendMessage(req);
    toaster.dismiss(key); // the background's toast (same position) takes over
  } catch (e) {
    toaster.show({ key, state: 'error', text: `Could not send: ${e instanceof Error ? e.message : String(e)}` });
  }
}

window.__contextKitDevdy = {
  sendSelection: (range, text) => void sendSelection(range, text),
};

if (alive()) {
  chrome.runtime.onMessage.addListener((msg: WebToastMessage) => {
    if (msg?.target === WEB_TOAST_TARGET) toaster.show(msg);
  });
}
