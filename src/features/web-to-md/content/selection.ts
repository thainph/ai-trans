// DOM helpers for capturing the user's selection (no chrome.* → unit-tested).

import type { PageMeta } from '../core/web-capture';

/** Tiny placeholder images lazy-loaders put in `src` before the real one loads. */
const PLACEHOLDER_RE = /^data:image\/(gif|png|svg\+xml)[;,]/i;
const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-actualsrc', 'data-url'];

/** Largest candidate of a `srcset` ("a.png 1x, b.png 2x" / "a.png 480w, b.png 960w"). */
export function largestFromSrcset(srcset: string | null): string | null {
  if (!srcset) return null;
  let best: { url: string; size: number } | null = null;
  for (const part of srcset.split(/,\s+/)) {
    const [url, descriptor = '1x'] = part.trim().split(/\s+/);
    if (!url) continue;
    const size = parseFloat(descriptor) * (descriptor.endsWith('w') ? 1 : 1000);
    if (!best || size > best.size) best = { url, size: Number.isFinite(size) ? size : 0 };
  }
  return best?.url ?? null;
}

/** The real image URL of an <img> (lazy-loading attributes, srcset, src). */
export function bestImageSrc(img: Element): string | null {
  const src = img.getAttribute('src');
  for (const a of LAZY_ATTRS) {
    const v = img.getAttribute(a);
    if (v && (!src || PLACEHOLDER_RE.test(src))) return v;
  }
  const fromSet = largestFromSrcset(img.getAttribute('srcset') ?? img.getAttribute('data-srcset'));
  if (fromSet && (!src || PLACEHOLDER_RE.test(src))) return fromSet;
  return src || fromSet;
}

/** HTML of a selection, with images pointing at their real (absolute) URLs. */
export function selectionHtml(range: Range, baseUrl: string): string {
  const div = range.startContainer.ownerDocument!.createElement('div');
  div.appendChild(range.cloneContents());
  for (const img of div.querySelectorAll('img')) {
    const src = bestImageSrc(img);
    if (!src) continue;
    try {
      img.setAttribute('src', new URL(src, baseUrl).toString());
    } catch {
      img.setAttribute('src', src);
    }
    img.removeAttribute('srcset');
  }
  return div.innerHTML;
}

/** Page metadata for the Devdy front matter (title, site, author, …). */
export function pageMeta(doc: Document, url: string): PageMeta {
  const meta = (name: string) => {
    const el = doc.querySelector(`meta[property="${name}"]`) ?? doc.querySelector(`meta[name="${name}"]`);
    return el?.getAttribute('content')?.trim() || undefined;
  };
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // keep empty
  }
  return {
    url,
    pageTitle: meta('og:title') || doc.title.trim() || undefined,
    siteName: meta('og:site_name') || host || undefined,
    author: meta('author') || meta('article:author'),
    description: meta('description') || meta('og:description'),
    publishedAt: meta('article:published_time'),
  };
}
