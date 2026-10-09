// Background side of the "Markdown + attachments as .zip" export.
// The heavy lifting (fetching files with cookies, zipping, blob: URL) happens
// in the offscreen document; this module orchestrates it.

import { type AttachmentOutcome, type AttachmentPlan, MAX_FILE_BYTES } from '../core/attachments';
import { mapPool } from '../core/slack-client';
import type { PlannedImage } from '../core/web-capture';
import {
  type BuildZipResponse,
  type FetchFileResponse,
  type FetchImageResponse,
  OFFSCREEN_TARGET,
  type OffscreenRequest,
  type StoreZipResponse,
} from '../types/offscreen';
import { chromePing, KEEPALIVE_CHUNK_MS } from './keepalive';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const FILE_CONCURRENCY = 3;
/** Give up waiting for the download to finish before revoking the blob URL. */
const DOWNLOAD_WAIT_MS = 10 * 60_000;

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Fetch Slack attachments and build a zip blob for chrome.downloads.',
    })
    .catch((e: unknown) => {
      // Already open (e.g. a previous export) is fine.
      if (!String(e instanceof Error ? e.message : e).includes('single offscreen')) throw e;
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

function send<T>(msg: OffscreenRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/** Resolve when the download completes/fails, or after `timeoutMs`. */
function waitForDownload(downloadId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve();
    };
    const onChanged = (d: chrome.downloads.DownloadDelta) => {
      if (d.id === downloadId && (d.state?.current === 'complete' || d.state?.current === 'interrupted')) done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

export interface ZipFetchResult {
  /** Outcome for every planned/skipped file id. */
  outcomes: Map<string, AttachmentOutcome>;
  saved: number;
  failed: number;
}

export interface ZipJob {
  /** Download all planned files into the job (offscreen memory). */
  fetchFiles(plan: AttachmentPlan, onProgress: (text: string) => void): Promise<ZipFetchResult>;
  /**
   * Download web images into the job. Returns url → zip path for the saved ones;
   * stops adding once `maxTotalBytes` is reached.
   */
  fetchImages(
    images: PlannedImage[],
    opts: { maxBytes: number; maxTotalBytes: number },
    onProgress: (text: string) => void,
  ): Promise<{ saved: Map<string, string>; failed: number }>;
  /** Zip fetched files + markdown and save it via chrome.downloads. */
  saveZip(markdownPath: string, markdown: string, zipFilename: string, opts?: { saveAs?: boolean }): Promise<void>;
  /** Zip fetched files + markdown into the IndexedDB outbox (Devdy export). Returns the zip size. */
  storeZip(blobId: string, markdownPath: string, markdown: string): Promise<number>;
  /** Always call (finally): frees offscreen memory. */
  dispose(): void;
}

export async function startZipJob(): Promise<ZipJob> {
  await ensureOffscreen();
  const jobId = crypto.randomUUID();
  // Fetching big files can take longer than the 30 s MV3 idle timeout.
  const keepalive = setInterval(() => void chromePing(), KEEPALIVE_CHUNK_MS);
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    void send({ target: OFFSCREEN_TARGET, type: 'release', jobId }).catch(() => {});
  };

  return {
    async fetchFiles(plan, onProgress) {
      const outcomes = new Map<string, AttachmentOutcome>(plan.skipped);
      let done = 0;
      let saved = 0;
      let failed = 0;
      const total = plan.downloads.length;
      onProgress(`Downloading files… 0/${total}`);
      await mapPool(plan.downloads, FILE_CONCURRENCY, async (d) => {
        let res: FetchFileResponse;
        try {
          res = await send<FetchFileResponse>({
            target: OFFSCREEN_TARGET,
            type: 'fetch-file',
            jobId,
            url: d.url,
            path: d.path,
            maxBytes: MAX_FILE_BYTES,
          });
        } catch (e) {
          res = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (res?.ok) {
          outcomes.set(d.id, { kind: 'saved', path: d.path, isImage: d.isImage });
          saved++;
        } else {
          outcomes.set(d.id, { kind: 'skipped', reason: `download failed: ${res?.error ?? 'unknown error'}` });
          failed++;
        }
        done++;
        onProgress(`Downloading files… ${done}/${total}`);
      });
      return { outcomes, saved, failed };
    },

    async fetchImages(images, opts, onProgress) {
      const saved = new Map<string, string>();
      let failed = 0;
      let total = 0;
      let done = 0;
      onProgress(`Downloading images… 0/${images.length}`);
      await mapPool(images, FILE_CONCURRENCY, async (img) => {
        if (total >= opts.maxTotalBytes) {
          failed++;
        } else {
          let res: FetchImageResponse;
          try {
            res = await send<FetchImageResponse>({
              target: OFFSCREEN_TARGET,
              type: 'fetch-image',
              jobId,
              url: img.url,
              pathBase: img.pathBase,
              maxBytes: Math.min(opts.maxBytes, opts.maxTotalBytes - total),
            });
          } catch (e) {
            res = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
          if (res?.ok) {
            total += res.size;
            saved.set(img.url, res.path);
          } else {
            failed++;
          }
        }
        done++;
        onProgress(`Downloading images… ${done}/${images.length}`);
      });
      return { saved, failed };
    },

    async saveZip(markdownPath, markdown, zipFilename, opts = {}) {
      const res = await send<BuildZipResponse>({
        target: OFFSCREEN_TARGET,
        type: 'build-zip',
        jobId,
        texts: [{ path: markdownPath, text: markdown }],
      });
      if (!res?.ok) throw new Error(`Could not build the zip: ${res?.error ?? 'no response'}`);
      const downloadId = await chrome.downloads.download({
        url: res.url,
        filename: zipFilename,
        saveAs: opts.saveAs ?? false,
        conflictAction: 'uniquify',
      });
      // The blob URL must stay alive until Chrome has finished writing the file.
      await waitForDownload(downloadId, DOWNLOAD_WAIT_MS);
    },

    async storeZip(blobId, markdownPath, markdown) {
      const res = await send<StoreZipResponse>({
        target: OFFSCREEN_TARGET,
        type: 'store-zip',
        jobId,
        blobId,
        texts: [{ path: markdownPath, text: markdown }],
      });
      if (!res?.ok) throw new Error(`Could not build the zip: ${res?.error ?? 'no response'}`);
      return res.size;
    },

    dispose() {
      clearInterval(keepalive);
      release();
    },
  };
}
