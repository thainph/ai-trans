// DOM helpers for capturing the user's selection (no chrome.* → unit-tested).

import { extractInPage } from '../core/extract';
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

/**
 * Metadata for the Devdy front matter (title, site, author, …), read by the
 * same code as the Web → MD tab, but of the frame the selection is in: inside
 * an iframe that is the iframe's own URL/title, not the tab's (the Web → MD tab
 * takes them from the top frame). Intended: the iframe is where the selected
 * content comes from, and the top page's URL isn't reliably available to a
 * cross-origin frame (`document.referrer` depends on the referrer policy,
 * `location.ancestorOrigins` has origins only).
 */
export function pageMeta(): PageMeta {
  return extractInPage('selection', 'meta').meta;
}
