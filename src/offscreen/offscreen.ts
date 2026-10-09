// Offscreen document: fetches Slack-hosted attachments and builds the export
// zip. Runs as an extension page, so cross-origin fetches to files.slack.com
// are allowed by host permissions and carry the user's Slack cookies.

import { type Zippable, zipSync } from 'fflate';
import { putBlob } from '../features/devdy/core/blob-store';
import { isAllowedFileUrl, isCompressiblePath } from '../features/slack/core/attachments';
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

const FETCH_TIMEOUT_MS = 120_000;

interface Job {
  files: Map<string, Uint8Array>;
  blobUrl?: string;
}

const jobs = new Map<string, Job>();

function job(id: string): Job {
  let j = jobs.get(id);
  if (!j) {
    j = { files: new Map() };
    jobs.set(id, j);
  }
  return j;
}

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
  if (!isFetchableImageUrl(req.url)) return { ok: false, error: 'URL not allowed' };
  let res: Response;
  try {
    // Same request the page made to render it (cookies included for login-only images).
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

/** Zip every fetched file of the job plus the given text entries. */
function makeZip(jobId: string, texts: { path: string; text: string }[]): Uint8Array {
  const j = job(jobId);
  const enc = new TextEncoder();
  const entries: Zippable = {};
  for (const t of texts) entries[t.path] = [enc.encode(t.text), { level: 6 }];
  for (const [path, bytes] of j.files) entries[path] = [bytes, { level: isCompressiblePath(path) ? 6 : 0 }];
  const zipped = zipSync(entries);
  j.files.clear(); // the zip now owns the data
  return zipped;
}

const zipBlob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' });

function buildZip(req: Extract<OffscreenRequest, { type: 'build-zip' }>): BuildZipResponse {
  try {
    const zipped = makeZip(req.jobId, req.texts);
    const j = job(req.jobId);
    j.blobUrl = URL.createObjectURL(zipBlob(zipped));
    return { ok: true, url: j.blobUrl, size: zipped.byteLength };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function storeZip(req: Extract<OffscreenRequest, { type: 'store-zip' }>): Promise<StoreZipResponse> {
  try {
    const zipped = makeZip(req.jobId, req.texts);
    await putBlob(req.blobId, zipBlob(zipped));
    return { ok: true, size: zipped.byteLength };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

function release(jobId: string): void {
  const j = jobs.get(jobId);
  if (j?.blobUrl) URL.revokeObjectURL(j.blobUrl);
  jobs.delete(jobId);
}

onTargetMessage<OffscreenRequest>(OFFSCREEN_TARGET, (msg) => {
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
