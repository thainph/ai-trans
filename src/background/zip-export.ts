// Background side of the "Markdown + attachments as .zip" export.
// The heavy lifting (fetching files with cookies, zipping, blob: URL) happens
// in the offscreen document; this module orchestrates it.

import {
  type AttachmentOutcome,
  type AttachmentPlan,
  ByteBudget,
  formatBytes,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from '../features/slack/core/attachments';
import { mapPool } from '../features/slack/core/slack-client';
import type { PlannedImage } from '../features/web-to-md/core/web-capture';
import {
  type BuildZipResponse,
  type FetchFileResponse,
  type FetchImageResponse,
  OFFSCREEN_TARGET,
  type OffscreenRequest,
  type StoreZipResponse,
} from '../offscreen/messages';
import { errorMessage } from '../shared/errors';
import { fail } from '../shared/messaging';
import { chromePing, KEEPALIVE_CHUNK_MS } from './keepalive';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const FILE_CONCURRENCY = 3;
/** Give up waiting for the download to finish before revoking the blob URL. */
const DOWNLOAD_WAIT_MS = 10 * 60_000;
/**
 * Close the offscreen document this long after the last job ended (frees its
 * memory). Well under the ~30 s MV3 idle shutdown, which is reset by a ping
 * when the close is scheduled, so the timer normally fires; the alarm below is
 * the fallback when the worker is stopped anyway, and a worker that starts
 * with no job closes a leftover document right away.
 */
const OFFSCREEN_IDLE_MS = 10_000;
const CLOSE_ALARM = 'offscreen-close';
/** Alarm fallback (Chrome clamps it to ≥ 30 s; < 120: ≥ 1 min). */
const CLOSE_ALARM_MIN = 0.5;

let creating: Promise<void> | null = null;
let closing: Promise<void> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
/** Zip jobs started and not disposed yet. */
let activeJobs = 0;

/** Whether the offscreen document is open; null when Chrome can't tell (< 116). */
async function hasOffscreen(): Promise<boolean | null> {
  if (!('getContexts' in chrome.runtime)) return null;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (closing) await closing;
  if (creating) return creating;
  creating = (async () => {
    if (await hasOffscreen()) return;
    await chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification:
          'Fetch Slack attachments and web page images, build zip blobs for chrome.downloads and store them in IndexedDB for the Devdy outbox.',
      })
      .catch((e: unknown) => {
        // Already open (e.g. a previous export) is fine.
        if (!errorMessage(e).includes('single offscreen')) throw e;
      });
  })().finally(() => {
    creating = null;
  });
  return creating;
}

/** Close the offscreen document now unless a job is running (sets `closing` synchronously). */
function closeIfIdle(): void {
  clearTimeout(closeTimer);
  if (activeJobs > 0 || creating || closing) return;
  closing = (async () => {
    if ((await hasOffscreen()) === false) return;
    if (activeJobs > 0) return; // a job started meanwhile (it waits for `closing`)
    await chrome.offscreen.closeDocument();
  })()
    .catch(() => {
      // Not open: nothing to close.
    })
    .finally(() => {
      closing = null;
      void chrome.alarms.clear(CLOSE_ALARM);
    });
}

/** Close the offscreen document after OFFSCREEN_IDLE_MS without jobs (debounced). */
function scheduleClose(): void {
  clearTimeout(closeTimer);
  void chromePing(); // reset the worker's idle timer: the timeout below fits in it
  closeTimer = setTimeout(closeIfIdle, OFFSCREEN_IDLE_MS);
  void chrome.alarms.create(CLOSE_ALARM, { delayInMinutes: CLOSE_ALARM_MIN });
}

function cancelClose(): void {
  clearTimeout(closeTimer);
  void chrome.alarms.clear(CLOSE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLOSE_ALARM) closeIfIdle();
});

// A fresh worker has no job: a document left open by the previous instance is stale.
closeIfIdle();

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
  /**
   * Download all planned files into the job (offscreen memory). The total is
   * enforced on the real downloaded sizes (files without a size from Slack
   * included); files that don't fit are skipped with a reason.
   */
  fetchFiles(
    plan: AttachmentPlan,
    onProgress: (text: string) => void,
    opts?: { maxFileBytes?: number; maxTotalBytes?: number },
  ): Promise<ZipFetchResult>;
  /**
   * Download web images into the job. Returns url → zip path for the saved ones;
   * stops adding once `maxTotalBytes` is reached. Cookies are sent only to
   * images of the same site as `pageUrl`.
   */
  fetchImages(
    images: PlannedImage[],
    opts: { maxBytes: number; maxTotalBytes: number; pageUrl?: string },
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
  activeJobs++;
  cancelClose();
  try {
    await ensureOffscreen();
  } catch (e) {
    activeJobs--;
    scheduleClose();
    throw e;
  }
  const jobId = crypto.randomUUID();
  // Fetching big files can take longer than the 30 s MV3 idle timeout.
  const keepalive = setInterval(() => void chromePing(), KEEPALIVE_CHUNK_MS);
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    void send({ target: OFFSCREEN_TARGET, type: 'release', jobId }).catch(() => {});
    activeJobs--;
    if (activeJobs === 0) scheduleClose();
  };

  return {
    async fetchFiles(plan, onProgress, opts = {}) {
      const maxFile = opts.maxFileBytes ?? MAX_FILE_BYTES;
      const budget = new ByteBudget(opts.maxTotalBytes ?? MAX_TOTAL_BYTES);
      const overBudget = `export size limit (${formatBytes(budget.total)}) reached`;
      const outcomes = new Map<string, AttachmentOutcome>(plan.skipped);
      let done = 0;
      let saved = 0;
      let failed = 0;
      const total = plan.downloads.length;
      onProgress(`Downloading files… 0/${total}`);
      await mapPool(plan.downloads, FILE_CONCURRENCY, async (d) => {
        // Reserve before fetching: parallel downloads can't overshoot the total.
        const known = d.size !== undefined;
        const grant = await budget.reserve(known ? Math.min(d.size!, maxFile) : maxFile, known);
        if (grant === null) {
          outcomes.set(d.id, { kind: 'skipped', reason: overBudget });
        } else {
          let res: FetchFileResponse;
          try {
            res = await send<FetchFileResponse>({
              target: OFFSCREEN_TARGET,
              type: 'fetch-file',
              jobId,
              url: d.url,
              path: d.path,
              maxBytes: grant,
            });
          } catch (e) {
            res = fail(e);
          }
          budget.settle(grant, res?.ok ? res.size : 0);
          if (res?.ok) {
            outcomes.set(d.id, { kind: 'saved', path: d.path, isImage: d.isImage });
            saved++;
          } else if (grant < maxFile && res?.error?.startsWith('too large')) {
            // Bigger than what was left of the total (size unknown up front).
            outcomes.set(d.id, { kind: 'skipped', reason: overBudget });
          } else {
            outcomes.set(d.id, { kind: 'skipped', reason: `download failed: ${res?.error ?? 'unknown error'}` });
            failed++;
          }
        }
        done++;
        onProgress(`Downloading files… ${done}/${total}`);
      });
      return { outcomes, saved, failed };
    },

    async fetchImages(images, opts, onProgress) {
      const saved = new Map<string, string>();
      const budget = new ByteBudget(opts.maxTotalBytes);
      let failed = 0;
      let done = 0;
      onProgress(`Downloading images… 0/${images.length}`);
      await mapPool(images, FILE_CONCURRENCY, async (img) => {
        const grant = await budget.reserve(opts.maxBytes, false);
        if (grant === null) {
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
              maxBytes: grant,
              pageUrl: opts.pageUrl,
            });
          } catch (e) {
            res = fail(e);
          }
          budget.settle(grant, res?.ok ? res.size : 0);
          if (res?.ok) saved.set(img.url, res.path);
          else failed++;
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
