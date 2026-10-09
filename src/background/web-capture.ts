// Send a web page or a selection to Devdy (POST /v1/web-pages):
// Markdown → download referenced images into images/ → zip (or plain .md) →
// outbox (queued + retried when Devdy is down).

import type { SendOutcome } from '../core/devdy-client';
import {
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  type PageMeta,
  collectImageUrls,
  firstLineTitle,
  planImages,
  rewriteImageLinks,
  webFrontMatter,
} from '../core/web-capture';
import type { ToastState } from '../types/quick-send';
import { WEB_TARGET, WEB_TOAST_TARGET, type WebRequest, type WebSendResult, type WebToastMessage } from '../types/web';
import { outbox } from './devdy';
import { openSettings } from './settings';
import { startZipJob } from './zip-export';

const PAGE_MD = 'page.md';

export interface WebCaptureInput {
  markdown: string;
  page: PageMeta;
  selection: boolean;
  /** Title for the capture (selection: first line of the selected text). */
  title?: string;
}

export async function sendWebCapture(
  input: WebCaptureInput,
  onProgress: (text: string) => void = () => {},
): Promise<WebSendResult> {
  const id = crypto.randomUUID();
  const head = webFrontMatter(input.page, { title: input.title, selection: input.selection, capturedAt: new Date() });
  const images = planImages(collectImageUrls(input.markdown));

  let blob: Blob | null = null;
  let contentType = 'text/markdown; charset=utf-8';
  let stats = { saved: 0, failed: 0 };
  let body = input.markdown;

  if (images.length > 0) {
    const job = await startZipJob();
    try {
      const { saved, failed } = await job.fetchImages(
        images,
        { maxBytes: MAX_IMAGE_BYTES, maxTotalBytes: MAX_TOTAL_IMAGE_BYTES },
        onProgress,
      );
      stats = { saved: saved.size, failed };
      if (saved.size > 0) {
        body = rewriteImageLinks(input.markdown, saved);
        onProgress('Building zip…');
        await job.storeZip(id, PAGE_MD, head + body); // written straight into the outbox
        contentType = 'application/zip';
      }
    } finally {
      job.dispose();
    }
  }
  if (contentType !== 'application/zip') {
    blob = new Blob([head + body], { type: 'text/markdown;charset=utf-8' });
  }

  onProgress('Sending to Devdy…');
  const title = input.title ?? input.page.pageTitle ?? input.page.url;
  const r = await outbox.enqueue({ id, kind: 'web-pages', title, contentType }, blob);
  return { delivery: { kind: r.outcome.kind, message: r.message, pending: r.pending }, images: stats };
}

// ---- toasts in the page ------------------------------------------------------

function toastState(kind: SendOutcome['kind']): { state: ToastState; action?: 'open-settings' } {
  switch (kind) {
    case 'created':
    case 'updated':
      return { state: 'success' };
    case 'unreachable':
    case 'server_error':
      return { state: 'queued' };
    case 'choose_instance':
      return { state: 'queued', action: 'open-settings' };
    case 'no_token':
    case 'unauthorized':
      return { state: 'error', action: 'open-settings' };
    case 'rejected':
      return { state: 'error' };
  }
}

export function resultText(r: WebSendResult, what: string): string {
  const imgs = r.images.saved
    ? ` (${r.images.saved} image${r.images.saved === 1 ? '' : 's'}${r.images.failed ? `, ${r.images.failed} kept as links` : ''})`
    : '';
  if (r.delivery.kind === 'created') return `${what} sent to Devdy${imgs}.`;
  if (r.delivery.kind === 'updated') return `${what} updated in Devdy${imgs}.`;
  return r.delivery.message;
}

function toast(tabId: number, frameId: number | undefined, msg: Omit<WebToastMessage, 'target'>): void {
  const full: WebToastMessage = { target: WEB_TOAST_TARGET, ...msg };
  chrome.tabs.sendMessage(tabId, full, frameId !== undefined ? { frameId } : undefined).catch(() => {});
}

chrome.runtime.onMessage.addListener((req: WebRequest, sender, sendResponse) => {
  if (req?.target !== WEB_TARGET) return;

  if (req.type === 'send-selection') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const key = crypto.randomUUID();
    sendResponse({ accepted: true });
    toast(tabId, sender.frameId, { key, state: 'progress', text: 'Sending selection to Devdy…' });
    sendWebCapture(
      { markdown: req.markdown, page: req.page, selection: true, title: firstLineTitle(req.selectionText) },
      (text) => toast(tabId, sender.frameId, { key, state: 'progress', text }),
    )
      .then((r) => toast(tabId, sender.frameId, { key, ...toastState(r.delivery.kind), text: resultText(r, 'Selection') }))
      .catch((e: unknown) =>
        toast(tabId, sender.frameId, { key, state: 'error', text: `Could not send: ${e instanceof Error ? e.message : String(e)}` }),
      );
    return;
  }

  if (req.type === 'send-page') {
    const title = req.selection && req.selectionText ? firstLineTitle(req.selectionText) : undefined;
    sendWebCapture({ markdown: req.markdown, page: req.page, selection: req.selection, title })
      .then((r) => sendResponse({ ok: true, result: r, text: resultText(r, req.selection ? 'Selection' : 'Page') }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true; // async response
  }

  if (req.type === 'open-settings') {
    void openSettings();
    sendResponse({ ok: true });
  }
});
