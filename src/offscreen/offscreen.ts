// Offscreen document: fetches Slack-hosted attachments and builds the export
// zip. Runs as an extension page, so cross-origin fetches to files.slack.com
// are allowed by host permissions and carry the user's Slack cookies.

import { type Zippable, zipSync } from 'fflate';
import { isAllowedFileUrl, isCompressiblePath } from '../core/attachments';
import {
  type BuildZipResponse,
  type FetchFileResponse,
  OFFSCREEN_TARGET,
  type OffscreenRequest,
} from '../types/offscreen';

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
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function buildZip(req: Extract<OffscreenRequest, { type: 'build-zip' }>): BuildZipResponse {
  try {
    const j = job(req.jobId);
    const enc = new TextEncoder();
    const entries: Zippable = {};
    for (const t of req.texts) entries[t.path] = [enc.encode(t.text), { level: 6 }];
    for (const [path, bytes] of j.files) entries[path] = [bytes, { level: isCompressiblePath(path) ? 6 : 0 }];
    const zipped = zipSync(entries);
    j.files.clear(); // the zip now owns the data
    j.blobUrl = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
    return { ok: true, url: j.blobUrl, size: zipped.byteLength };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function release(jobId: string): void {
  const j = jobs.get(jobId);
  if (j?.blobUrl) URL.revokeObjectURL(j.blobUrl);
  jobs.delete(jobId);
}

chrome.runtime.onMessage.addListener((msg: OffscreenRequest, _sender, sendResponse) => {
  if (msg?.target !== OFFSCREEN_TARGET) return;
  switch (msg.type) {
    case 'fetch-file':
      fetchFile(msg).then(sendResponse);
      return true; // async response
    case 'build-zip':
      sendResponse(buildZip(msg));
      return;
    case 'release':
      release(msg.jobId);
      sendResponse({ ok: true });
      return;
  }
});
