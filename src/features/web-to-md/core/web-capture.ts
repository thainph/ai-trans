// Web page / selection captures for Devdy's `POST /v1/web-pages` (pure, unit-tested).
//
// Front matter keys follow the Devdy contract: title, url, site_name, author,
// published_at, captured_at, description, selection. Images referenced in the
// Markdown are downloaded into `images/…` inside the zip and the links are
// rewritten to those relative paths so Devdy renders them inline.

import { safeFileName } from '../../../shared/filename';

export interface PageMeta {
  url: string;
  /** Page <title> / og:title. */
  pageTitle?: string;
  siteName?: string;
  author?: string;
  description?: string;
  publishedAt?: string;
}

/** Devdy's own fallback is the first body line, capped at 120 chars. */
export const TITLE_MAX = 120;
export const IMAGES_DIR = 'images';
/** Image caps: stay under Devdy's 50 MB body / 200 entries. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 45 * 1024 * 1024;
export const MAX_IMAGES = 199;

/** First non-empty line of the selected text, trimmed and capped (selection captures). */
export function firstLineTitle(text: string, max = TITLE_MAX): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!line) return undefined;
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : line;
}

const yamlString = (v: string) => JSON.stringify(v);

export function webFrontMatter(
  meta: PageMeta,
  opts: { title?: string; selection: boolean; capturedAt: Date },
): string {
  const lines = ['---'];
  const title = opts.title ?? meta.pageTitle;
  if (title) lines.push(`title: ${yamlString(title)}`);
  lines.push(`url: ${yamlString(meta.url)}`);
  if (meta.siteName) lines.push(`site_name: ${yamlString(meta.siteName)}`);
  if (meta.author) lines.push(`author: ${yamlString(meta.author)}`);
  if (meta.publishedAt) lines.push(`published_at: ${yamlString(meta.publishedAt)}`);
  lines.push(`captured_at: ${yamlString(opts.capturedAt.toISOString())}`);
  if (meta.description) lines.push(`description: ${yamlString(meta.description)}`);
  lines.push(`selection: ${opts.selection}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n`;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** `![alt](url)` — url without spaces/parens (what the converter emits). */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

export function isFetchableImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^data:image\/[a-z0-9.+-]+[;,]/i.test(url);
}

/** Unique image URLs referenced in the Markdown, in order. */
export function collectImageUrls(markdown: string): string[] {
  const seen = new Set<string>();
  for (const m of markdown.matchAll(IMAGE_RE)) {
    const url = m[2]!;
    if (isFetchableImageUrl(url)) seen.add(url);
  }
  return [...seen];
}

export interface PlannedImage {
  url: string;
  /** Path inside the zip without extension, e.g. "images/03-diagram"; the
   *  extension is added from the response Content-Type. */
  pathBase: string;
}

/** Name images `images/NN-<name>` (name from the URL path; "image" for data: URLs). */
export function planImages(urls: string[], maxImages = MAX_IMAGES): PlannedImage[] {
  const picked = urls.slice(0, maxImages);
  const width = Math.max(2, String(picked.length).length);
  return picked.map((url, i) => {
    let name = 'image';
    if (!url.startsWith('data:')) {
      try {
        const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
        name = last.replace(/\.[a-z0-9]{1,5}$/i, '') || 'image';
      } catch {
        // keep "image"
      }
    }
    const safe = safeFileName(name, 60).replace(/\./g, '-') || 'image';
    return { url, pathBase: `${IMAGES_DIR}/${String(i + 1).padStart(width, '0')}-${safe}` };
  });
}

/** Extension for an image Content-Type (falls back to the URL, then "img"). */
export function imageExtension(contentType: string | null | undefined, url = ''): string {
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const byType: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
  };
  if (byType[ct]) return byType[ct]!;
  const fromUrl = url.startsWith('data:') ? '' : (url.split(/[?#]/)[0]!.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? '');
  return fromUrl.toLowerCase() || 'img';
}

/** Point image links at the files saved in the zip; other images keep their URL. */
export function rewriteImageLinks(markdown: string, saved: ReadonlyMap<string, string>): string {
  if (saved.size === 0) return markdown;
  return markdown.replace(IMAGE_RE, (whole, alt: string, url: string) => {
    const path = saved.get(url);
    return path ? `![${alt}](${path})` : whole;
  });
}
