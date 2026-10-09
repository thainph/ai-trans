// Offscreen document: fetches Slack-hosted attachments and builds the export
// zip. Runs as an extension page, so cross-origin fetches to files.slack.com
// are allowed by host permissions and carry the user's Slack cookies.

import { fromExtension } from '../features/devdy/background/sender';
import { putBlob } from '../features/devdy/core/blob-store';
import { isAllowedFileUrl } from '../features/slack/core/attachments';
import { imageExtension, isFetchableImageUrl } from '../features/web-to-md/core/web-capture';
import { errorMessage } from '../shared/errors';
import { onTargetMessage, type Result } from '../shared/messaging';
import {
  type BuildZipResponse,
  type FetchFileResponse,
  type FetchImageResponse,
  OFFSCREEN_TARGET,
  type OffscreenRequest,
  type StoreZipResponse,
} from './messages';
import { isPublicHttpUrl, isSameSite } from './url-safety';
import { buildZipBlob } from './zip-stream';

const FETCH_TIMEOUT_MS = 120_000;
/**
 * Jobs untouched this long are freed (service worker died before `release`).
 * Longer than the background's 10 min wait for a zip download to finish.
 */
const JOB_TTL_MS = 15 * 60_000;

interface Job {
  files: Map<string, Uint8Array>;
  blobUrl?: string;
  touched: number;
}

const jobs = new Map<string, Job>();

function job(id: string): Job {
  let j = jobs.get(id);
  if (!j) {
    j = { files: new Map(), touched: Date.now() };
    jobs.set(id, j);
  }
  j.touched = Date.now();
  return j;
}

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.touched < cutoff) release(id);
}, 60_000);

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`too large (${declared} bytes)`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      throw new Error(`too large (> ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function fetchFile(req: Extract<OffscreenRequest, { type: 'fetch-file' }>): Promise<FetchFileResponse> {
  if (!isAllowedFileUrl(req.url)) return { ok: false, error: 'URL not allowed' };
  let res: Response;
  try {
    res = await fetch(req.url, {
      credentials: 'include',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
    return { ok: false, error: timedOut ? 'download timed out' : 'network error' };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  // Not logged in → Slack redirects to an HTML sign-in page (still 200).
  const type = res.headers.get('Content-Type') ?? '';
  const htmlExpected = /\.html?$/i.test(req.path);
  if (!isAllowedFileUrl(res.url) || (type.startsWith('text/html') && !htmlExpected)) {
    return { ok: false, error: 'Slack did not return the file (not logged in?)' };
  }
  try {
    const bytes = await readCapped(res, req.maxBytes);
    job(req.jobId).files.set(req.path, bytes);
    return { ok: true, size: bytes.byteLength };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function fetchImage(req: Extract<OffscreenRequest, { type: 'fetch-image' }>): Promise<FetchImageResponse> {
  const isData = req.url.startsWith('data:');
  if (!isFetchableImageUrl(req.url) || (!isData && !isPublicHttpUrl(req.url))) {
    return { ok: false, error: 'URL not allowed' };
  }
  let res: Response;
  try {
    // Cookies only for images of the page's own site (login-only images);
    // never send the user's cookies to third parties.
    res = await fetch(req.url, {
      credentials: !isData && isSameSite(req.url, req.pageUrl) ? 'include' : 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
    return { ok: false, error: timedOut ? 'download timed out' : 'network error' };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  // A redirect may have led to a private address: don't keep what it returned.
  if (!isData && !isPublicHttpUrl(res.url || req.url)) return { ok: false, error: 'URL not allowed' };
  const type = res.headers.get('Content-Type') ?? '';
  const ext = imageExtension(type, req.url);
  if (!type.toLowerCase().startsWith('image/') && ext === 'img')
    return { ok: false, error: `not an image (${type || 'unknown type'})` };
  try {
    const bytes = await readCapped(res, req.maxBytes);
    const path = `${req.pathBase}.${ext}`;
    job(req.jobId).files.set(path, bytes);
    return { ok: true, path, size: bytes.byteLength };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

function buildZip(req: Extract<OffscreenRequest, { type: 'build-zip' }>): BuildZipResponse {
  try {
    const j = job(req.jobId);
    const blob = buildZipBlob(j.files, req.texts);
    j.blobUrl = URL.createObjectURL(blob);
    return { ok: true, url: j.blobUrl, size: blob.size };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function storeZip(req: Extract<OffscreenRequest, { type: 'store-zip' }>): Promise<StoreZipResponse> {
  try {
    const blob = buildZipBlob(job(req.jobId).files, req.texts);
    await putBlob(req.blobId, blob);
    return { ok: true, size: blob.size };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

function release(jobId: string): void {
  const j = jobs.get(jobId);
  if (j?.blobUrl) URL.revokeObjectURL(j.blobUrl);
  jobs.delete(jobId);
}

onTargetMessage<OffscreenRequest>(OFFSCREEN_TARGET, (msg, sender) => {
  // Fetches with the user's cookies and IndexedDB writes: only for the service worker.
  if (!fromExtension(sender)) return { ok: false, error: 'Not allowed.' } satisfies Result;
  switch (msg.type) {
    case 'fetch-file':
      return fetchFile(msg);
    case 'fetch-image':
      return fetchImage(msg);
    case 'build-zip':
      return buildZip(msg);
    case 'store-zip':
      return storeZip(msg);
    case 'release':
      release(msg.jobId);
      return { ok: true } satisfies Result;
  }
});
