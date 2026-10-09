// Streaming zip writer (fflate `Zip`). Each downloaded file is added as soon
// as it has been fetched, and the zip output is folded into Blob parts every
// few MB — so the offscreen document never holds every file at once: peak
// memory is about the files being downloaded in parallel + one flush window.
// The Markdown (written last, once the download outcomes are known) ends the zip.

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { isPrecompressedPath } from '../shared/filename';

/** Move collected zip output into a Blob part past this many bytes. */
const FLUSH_BYTES = 8 * 1024 * 1024;

export class ZipWriter {
  private readonly zip: Zip;
  private readonly parts: Blob[] = [];
  private chunks: Uint8Array[] = [];
  private pending = 0;
  private error: Error | null = null;
  private finished = false;
  private closed = false;
  private readonly paths = new Set<string>();

  constructor() {
    this.zip = new Zip((err, chunk, final) => {
      if (err) {
        this.error = err;
        return;
      }
      this.chunks.push(chunk);
      this.pending += chunk.byteLength;
      if (this.pending >= FLUSH_BYTES) this.flush();
      if (final) this.finished = true;
    });
  }

  /** Files added so far. */
  get count(): number {
    return this.paths.size;
  }

  private flush(): void {
    if (this.chunks.length === 0) return;
    this.parts.push(new Blob(this.chunks as Uint8Array<ArrayBuffer>[]));
    this.chunks = [];
    this.pending = 0;
  }

  /**
   * Add one complete file. Already-compressed formats (png, jpg, zip, pdf,
   * mp4…) are stored, the rest deflated. The caller should drop `bytes` after.
   */
  add(path: string, bytes: Uint8Array): void {
    if (this.closed) throw new Error('zip already finished');
    if (this.paths.has(path)) throw new Error(`duplicate zip entry: ${path}`);
    this.paths.add(path);
    const entry = isPrecompressedPath(path) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
    this.zip.add(entry);
    entry.push(bytes, true); // synchronous: the entry is complete when this returns
    if (this.error) throw this.error;
  }

  /** Add the text entries, close the zip and return it. */
  finish(texts: { path: string; text: string }[]): Blob {
    const enc = new TextEncoder();
    for (const t of texts) this.add(t.path, enc.encode(t.text));
    this.closed = true;
    this.zip.end();
    if (this.error) throw this.error;
    if (!this.finished) throw new Error('zip did not finish');
    this.flush();
    return new Blob(this.parts, { type: 'application/zip' });
  }

  /** Drop everything (job released before finishing). */
  abort(): void {
    this.closed = true;
    this.zip.terminate();
    this.parts.length = 0;
    this.chunks = [];
  }
}
