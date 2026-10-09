// Messages between the background worker and the offscreen document
// (src/offscreen). The offscreen page exists because MV3 service workers can't
// create blob: URLs, and data: URLs are capped at ~2 MB for downloads.

export const OFFSCREEN_TARGET = 'context-kit-offscreen';

export type OffscreenRequest =
  /** Fetch one Slack file (with browser cookies) and keep it for job `jobId`. */
  | { target: typeof OFFSCREEN_TARGET; type: 'fetch-file'; jobId: string; url: string; path: string; maxBytes: number }
  /**
   * Fetch one web image (http(s) or data:image) for job `jobId`, stored at
   * `pathBase` + extension from its Content-Type. Non-image responses are rejected.
   */
  | { target: typeof OFFSCREEN_TARGET; type: 'fetch-image'; jobId: string; url: string; pathBase: string; maxBytes: number }
  /** Zip every fetched file of the job plus the given text entries; returns a blob: URL. */
  | { target: typeof OFFSCREEN_TARGET; type: 'build-zip'; jobId: string; texts: { path: string; text: string }[] }
  /** Like build-zip, but stores the zip in the IndexedDB outbox under `blobId` (Devdy export). */
  | { target: typeof OFFSCREEN_TARGET; type: 'store-zip'; jobId: string; blobId: string; texts: { path: string; text: string }[] }
  /** Free the job's memory and revoke its blob: URL. */
  | { target: typeof OFFSCREEN_TARGET; type: 'release'; jobId: string };

export type FetchFileResponse = { ok: true; size: number } | { ok: false; error: string };
export type FetchImageResponse = { ok: true; path: string; size: number } | { ok: false; error: string };
export type BuildZipResponse = { ok: true; url: string; size: number } | { ok: false; error: string };
export type StoreZipResponse = { ok: true; size: number } | { ok: false; error: string };
