// Streaming zip builder (fflate `Zip`). Each file is pushed, then dropped from
// the job's map, and the zip output is folded into Blob parts every few MB —
// so peak memory stays near one file + one flush window instead of every file
// plus the whole zip (zipSync).

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { isPrecompressedPath } from '../features/slack/core/attachments';

/** Move collected zip output into a Blob part past this many bytes. */
const FLUSH_BYTES = 8 * 1024 * 1024;

/**
 * Zip `texts` then every entry of `files` (deleted from the map as added).
 * Already-compressed formats (png, jpg, zip, pdf, mp4…) are stored, the rest deflated.
 */
export function buildZipBlob(files: Map<string, Uint8Array>, texts: { path: string; text: string }[]): Blob {
  const parts: Blob[] = [];
  let chunks: Uint8Array[] = [];
  let pending = 0;
  let error: Error | null = null;
  let finished = false;

  const flush = () => {
    if (chunks.length === 0) return;
    parts.push(new Blob(chunks as Uint8Array<ArrayBuffer>[]));
    chunks = [];
    pending = 0;
  };

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      error = err;
      return;
    }
    chunks.push(chunk);
    pending += chunk.byteLength;
    if (pending >= FLUSH_BYTES) flush();
    if (final) finished = true;
  });

  const add = (path: string, bytes: Uint8Array) => {
    const entry = isPrecompressedPath(path) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
    zip.add(entry);
    entry.push(bytes, true);
  };

  const enc = new TextEncoder();
  for (const t of texts) add(t.path, enc.encode(t.text));
  for (const path of [...files.keys()]) {
    add(path, files.get(path)!);
    files.delete(path); // the zip output now owns the data
  }
  zip.end();
  if (error) throw error;
  if (!finished) throw new Error('zip did not finish');
  flush();
  return new Blob(parts, { type: 'application/zip' });
}
