// DOM helpers for capturing the user's selection (no chrome.* → unit-tested).

import { bestImageSrc } from '../core/image-src';
import type { PageMeta } from '../core/web-capture';

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
