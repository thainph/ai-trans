// Send a web page or a selection to Devdy (POST /v1/web-pages):
// Markdown → download referenced images into images/ → zip (or plain .md) →
// outbox (queued + retried when Devdy is down).

import { errorMessage } from '../../../shared/errors';
import { type Command, ok, onTargetMessage, type Result, sendToTab } from '../../../shared/messaging';
import { startZipJob } from '../../../shared/offscreen/zip-job';
import { fromExtensionPage } from '../../../shared/sender';
import type { ToastState } from '../../../shared/toast';
import { openSettings, outbox, type SendOutcome } from '../../devdy/api';
import {
  collectImageUrls,
  firstLineTitle,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  type PageMeta,
  planImages,
  rewriteImageLinks,
  webFrontMatter,
} from '../core/web-capture';
import {
  type DownloadPageResponse,
  type SendPageResponse,
  WEB_TARGET,
  WEB_TOAST_TARGET,
  type WebRequest,
  type WebSendResult,
  type WebToastMessage,
} from '../messages';
import { checkMarkdown } from './limits';

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

  // The zip is written to the outbox store before enqueue: keep the orphan cleanup off it.
  const unhold = outbox.hold(id);
  let r: Awaited<ReturnType<typeof outbox.enqueue>>;
  try {
    if (images.length > 0) {
      try {
        const job = await startZipJob();
        try {
          const { saved, failed } = await job.fetchImages(
            images,
            { maxBytes: MAX_IMAGE_BYTES, maxTotalBytes: MAX_TOTAL_IMAGE_BYTES, pageUrl: input.page.url },
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
      } catch {
        // Offscreen / zip failure: still send the page, as plain Markdown with the original image links.
        body = input.markdown;
        contentType = 'text/markdown; charset=utf-8';
        stats = { saved: 0, failed: images.length };
      }
    }
    if (contentType !== 'application/zip') {
      blob = new Blob([head + body], { type: 'text/markdown;charset=utf-8' });
    }

    onProgress('Sending to Devdy…');
    const title = input.title ?? input.page.pageTitle ?? input.page.url;
    r = await outbox.enqueue({ id, kind: 'web-pages', title, contentType }, blob);
  } finally {
    unhold();
  }
  return { delivery: { kind: r.outcome.kind, message: r.message, pending: r.pending }, images: stats };
}

/**
 * Web → MD "Download": when the Markdown references images, save a zip
 * (`<name>.md` + images/, links rewritten to them) — like the Slack export.
 * Without downloadable images the popup saves the plain .md.
 */
export async function downloadPageZip(
  markdown: string,
  filename: string,
  pageUrl?: string,
): Promise<DownloadPageResponse> {
  const images = planImages(collectImageUrls(markdown));
  if (images.length === 0) return { ok: true, zipped: false, images: { saved: 0, failed: 0 } };
  try {
    return await downloadZip(images, markdown, filename, pageUrl);
  } catch {
    // Offscreen / zip failure: the popup saves the plain .md (original image links).
    return { ok: true, zipped: false, images: { saved: 0, failed: images.length } };
  }
}

async function downloadZip(
  images: ReturnType<typeof planImages>,
  markdown: string,
  filename: string,
  pageUrl?: string,
): Promise<DownloadPageResponse> {
  const job = await startZipJob();
  try {
    const { saved, failed } = await job.fetchImages(
      images,
      { maxBytes: MAX_IMAGE_BYTES, maxTotalBytes: MAX_TOTAL_IMAGE_BYTES, pageUrl },
      () => {},
    );
    if (saved.size === 0) return { ok: true, zipped: false, images: { saved: 0, failed } };
    const zipName = `${filename.replace(/\.md$/i, '')}.zip`;
    // Same "Save as" dialog as the plain .md download.
    await job.saveZip(filename, rewriteImageLinks(markdown, saved), zipName, { saveAs: true });
    return { ok: true, zipped: true, filename: zipName, images: { saved: saved.size, failed } };
  } finally {
    job.dispose();
  }
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

const toast = (tabId: number, frameId: number | undefined, msg: Command<WebToastMessage>) =>
  sendToTab<WebToastMessage>(tabId, frameId, { target: WEB_TOAST_TARGET, ...msg });

/** Commands the all-frames content script may send; the rest come from the Web → MD tab only. */
const CONTENT_COMMANDS = new Set<WebRequest['type']>(['send-selection', 'open-settings']);

onTargetMessage<WebRequest>(WEB_TARGET, (req, sender) => {
  if (!CONTENT_COMMANDS.has(req.type) && !fromExtensionPage(sender)) {
    return { ok: false, error: 'Not allowed.' } satisfies Result;
  }
  if (req.type !== 'open-settings') {
    const invalid = checkMarkdown(req.markdown);
    if (invalid) return { ok: false, error: invalid } satisfies Result;
  }
  switch (req.type) {
    case 'send-selection': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return;
      const key = crypto.randomUUID();
      toast(tabId, sender.frameId, { key, state: 'progress', text: 'Sending selection to Devdy…' });
      sendWebCapture(
        {
          markdown: req.markdown,
          page: req.page,
          selection: true,
          title: firstLineTitle(String(req.selectionText ?? '').slice(0, 10_000)),
        },
        (text) => toast(tabId, sender.frameId, { key, state: 'progress', text }),
      )
        .then((r) =>
          toast(tabId, sender.frameId, { key, ...toastState(r.delivery.kind), text: resultText(r, 'Selection') }),
        )
        .catch((e: unknown) =>
          toast(tabId, sender.frameId, { key, state: 'error', text: `Could not send: ${errorMessage(e)}` }),
        );
      return { ok: true } satisfies Result; // accepted; progress/result arrive as toasts
    }
    case 'send-page': {
      const title = req.selection && req.selectionText ? firstLineTitle(req.selectionText) : undefined;
      return sendWebCapture({ markdown: req.markdown, page: req.page, selection: req.selection, title }).then(
        (r): SendPageResponse => ok({ result: r, text: resultText(r, req.selection ? 'Selection' : 'Page') }),
      );
    }
    case 'download-page':
      return downloadPageZip(req.markdown, req.filename, req.pageUrl);
    case 'open-settings':
      void openSettings();
      return { ok: true } satisfies Result;
  }
});
