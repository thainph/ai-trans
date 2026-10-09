// Page content script (all sites, all frames): "Send selection to Devdy" for the
// translator's selection toolbar (➤ button), plus the result toast.

import { errorMessage } from '../../../shared/errors';
import { isExtensionAlive } from '../../../shared/runtime';
import { Toaster } from '../../../shared/toast';
import { WEB_TARGET, WEB_TOAST_TARGET, type WebRequest, type WebToastMessage } from '../messages';
import { htmlToMarkdown } from '../core/converter';
import { pageMeta, selectionHtml } from './selection';


/** blob: images only exist in this page; inline small ones so Devdy gets them. */
const MAX_INLINE_BLOB_BYTES = 5 * 1024 * 1024;

const toaster = new Toaster((action) => {
  if (action === 'open-settings' && isExtensionAlive()) {
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

export async function sendSelection(range: Range, text: string): Promise<void> {
  if (!isExtensionAlive()) {
    toaster.show({ key: 'reloaded', state: 'error', text: 'Context Kit was updated. Reload this page and try again.' });
    return;
  }
  const key = 'local-' + Date.now();
  toaster.show({ key, state: 'progress', text: 'Preparing selection…' });
  try {
    const html = await inlineBlobImages(selectionHtml(range, location.href));
    const md = htmlToMarkdown(html, { keepImages: true, keepLinks: true, baseUrl: location.href });
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
    toaster.show({ key, state: 'error', text: `Could not send: ${errorMessage(e)}` });
  }
}

if (isExtensionAlive()) {
  chrome.runtime.onMessage.addListener((msg: WebToastMessage) => {
    if (msg?.target === WEB_TOAST_TARGET) toaster.show(msg);
  });
}
