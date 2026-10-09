// Planning for "download attachments into a .zip" (pure, unit-tested).
//
// The background worker plans which Slack-hosted files to download and where
// they go inside the zip; the offscreen document does the actual fetching;
// md-builder then renders local links (or a "not included" note) per file id.

import type { SlackFile, SlackMessage } from './types';

/** Per-file cap. Bigger files are skipped and linked instead. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Cap for the sum of all downloaded files in one export. */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** Folder for attachments inside the zip (Devdy links `attachments/<name>` in the Markdown). */
export const FILES_DIR = 'attachments';

/** What happened to one file (keyed by Slack file id). */
export type AttachmentOutcome =
  | { kind: 'saved'; path: string; isImage: boolean }
  | { kind: 'skipped'; reason: string };

export interface PlannedDownload {
  id: string;
  name: string;
  url: string;
  /** Path inside the zip, e.g. "attachments/03-screenshot.png". */
  path: string;
  isImage: boolean;
  /** Size reported by Slack (bytes), if known. */
  size?: number;
}

export interface AttachmentPlan {
  downloads: PlannedDownload[];
  /** Files decided up front not to download (external, too large…). */
  skipped: Map<string, AttachmentOutcome>;
}

export interface PlanOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** Max number of files to download (Devdy accepts at most 200 zip entries incl. the .md). */
  maxFiles?: number;
}

/**
 * Only Slack's file hosts. The offscreen document sends the browser's Slack
 * cookies with these requests, so never allow anything else.
 */
export function isAllowedFileUrl(u: unknown): u is string {
  if (typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      (host === 'files.slack.com' || (host.endsWith('.slack.com') && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)))
    );
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Filesystem/zip-safe name that keeps the extension, e.g. "Ảnh màn hình (2).png" -> "Ảnh-màn-hình-2.png". */
export function safeFileName(name: string, maxLen = 80): string {
  const clean = (s: string) =>
    s
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot >= name.length - 11;
  const ext = hasExt ? clean(name.slice(dot + 1)).toLowerCase() : '';
  const base = clean(hasExt ? name.slice(0, dot) : name) || 'file';
  const room = Math.max(1, maxLen - (ext ? ext.length + 1 : 0));
  return ext ? `${Array.from(base).slice(0, room).join('')}.${ext}` : Array.from(base).slice(0, room).join('');
}

export function isImageFile(f: SlackFile): boolean {
  if (typeof f.mimetype === 'string') return f.mimetype.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name ?? '');
}

/** Display name used in Markdown for a file. */
export function fileDisplayName(f: SlackFile): string {
  return f.name || f.title || 'file';
}

export function planAttachments(messages: SlackMessage[], options: PlanOptions = {}): AttachmentPlan {
  const maxFile = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotal = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;

  // Unique files in thread order.
  const files: SlackFile[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    for (const f of msg.files ?? []) {
      if (!f || typeof f.id !== 'string' || seen.has(f.id)) continue;
      // Deleted / over-plan files have no content; md-builder already labels them.
      if (f.mode === 'tombstone' || f.mode === 'hidden_by_limit') continue;
      seen.add(f.id);
      files.push(f);
    }
  }

  const downloads: PlannedDownload[] = [];
  const skipped = new Map<string, AttachmentOutcome>();
  const width = Math.max(2, String(files.length).length);
  let total = 0;
  let index = 0;

  for (const f of files) {
    const id = f.id as string;
    if (f.is_external || f.mode === 'external') {
      skipped.set(id, { kind: 'skipped', reason: 'external file' });
      continue;
    }
    const url = f.url_private_download || f.url_private;
    if (!isAllowedFileUrl(url)) {
      skipped.set(id, { kind: 'skipped', reason: 'no downloadable URL' });
      continue;
    }
    const size = typeof f.size === 'number' && f.size >= 0 ? f.size : undefined;
    if (size !== undefined && size > maxFile) {
      skipped.set(id, { kind: 'skipped', reason: `too large (${formatBytes(size)} > ${formatBytes(maxFile)})` });
      continue;
    }
    if (index >= maxFiles) {
      skipped.set(id, { kind: 'skipped', reason: `file count limit (${maxFiles}) reached` });
      continue;
    }
    if (size !== undefined && total + size > maxTotal) {
      skipped.set(id, { kind: 'skipped', reason: `export size limit (${formatBytes(maxTotal)}) reached` });
      continue;
    }
    total += size ?? 0;
    index++;
    downloads.push({
      id,
      name: fileDisplayName(f),
      url,
      path: `${FILES_DIR}/${String(index).padStart(width, '0')}-${safeFileName(fileDisplayName(f))}`,
      isImage: isImageFile(f),
      size,
    });
  }
  return { downloads, skipped };
}

/** File extensions worth deflating in the zip (others are stored as-is). */
export function isCompressiblePath(path: string): boolean {
  return /\.(md|txt|log|csv|tsv|json|xml|html?|css|js|ts|py|rb|go|java|sql|ya?ml|svg|diff|patch)$/i.test(path);
}
