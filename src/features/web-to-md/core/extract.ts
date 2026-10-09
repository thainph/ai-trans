// extractInPage(mode, depth) runs inside the page via chrome.scripting.executeScript
// ({ func: extractInPage }), so it must stay SELF-CONTAINED: no imports, no
// outer variables (type-only imports are fine). Returns plain data only.
// It is also the single source of page metadata for selection captures
// (content/selection.ts pageMeta() calls it with depth "meta").
// Unit-tested in tests/web-extract.test.ts.

import type { PageMeta } from './web-capture';

export type ExtractMode = 'article' | 'full' | 'selection';

/**
 * How much work to do / data to return:
 * - "meta": page metadata only (no content extraction);
 * - "score": also extract the content but return only its text length, so the
 *   popup can pick the best frame without shipping every frame's HTML over IPC;
 * - "content": everything, including `html` (and `text` in selection mode).
 */
export type ExtractDepth = 'meta' | 'score' | 'content';

export interface ExtractResult {
  meta: PageMeta;
  /** Extracted HTML ("" unless depth is "content"). */
  html: string;
  /** Length of the extracted text (whitespace collapsed); 0 at depth "meta". */
  textLen: number;
  isTop: boolean;
  mode: ExtractMode;
  /** Host of a Claude artifact's real content (claudeusercontent.com iframe), or "". */
  uchost: string;
  /** Selected plain text ("selection" mode, depth "content"). */
  text?: string;
}

export function extractInPage(mode: ExtractMode, depth: ExtractDepth = 'content'): ExtractResult {
  const meta = (name: string) => {
    const el = document.querySelector(`meta[property="${name}"]`) ?? document.querySelector(`meta[name="${name}"]`);
    return el?.getAttribute('content')?.trim() || undefined;
  };
  const host = location.hostname.replace(/^www\./, '');

  const result: ExtractResult = {
    meta: {
      url: location.href,
      pageTitle: meta('og:title') || document.title.trim() || undefined,
      siteName: meta('og:site_name') || host || undefined,
      author: meta('author') || meta('article:author'),
      description: meta('description') || meta('og:description'),
      publishedAt: meta('article:published_time'),
    },
    html: '',
    textLen: 0,
    isTop: window.top === window.self,
    mode: mode,
    uchost: '',
  };

  // Host of a Claude artifact's real content (claudeusercontent.com iframe)
  const slot = document.querySelector('[data-frame-uchost]');
  result.uchost = slot?.getAttribute('data-frame-uchost') || '';

  if (depth === 'meta') return result;

  const finalize = () => {
    // Parse into an inert <template>: no resource loads, no event handlers, and
    // nothing re-parsed into the live document (this runs in every frame).
    const tmp = document.createElement('template');
    tmp.innerHTML = result.html || '';
    result.textLen = (tmp.content.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (depth !== 'content') {
      result.html = '';
      delete result.text;
    }
    return result;
  };

  // Selection mode
  if (mode === 'selection') {
    const sel = window.getSelection();
    if (sel?.rangeCount && !sel.isCollapsed) {
      const div = document.createElement('div');
      for (let i = 0; i < sel.rangeCount; i++) {
        div.appendChild(sel.getRangeAt(i).cloneContents());
      }
      result.html = div.innerHTML;
      result.text = sel.toString();
    }
    return finalize();
  }

  // Full page
  if (mode === 'full') {
    result.html = document.body ? document.body.innerHTML : '';
    return finalize();
  }

  // Article mode: Readability-like heuristics
  const NOISE =
    'nav,header,footer,aside,form,button,.nav,.menu,.sidebar,.advert,.ads,.ad,.social,.share,.comment,.comments,.related,.newsletter,.subscribe,.cookie,.popup,.modal,[role=navigation],[role=banner],[role=complementary],[aria-hidden=true]';
  const textLen = (el: Element | null) =>
    ((el && ((el as HTMLElement).innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim().length;

  const main = document.querySelector('main') || document.querySelector('[role=main]');
  const scope: Element = main || document.body;
  // Top-level <article>s only (an <article> nested in another one is part of it).
  const articles = Array.from(document.querySelectorAll('article')).filter((a) => !a.parentElement?.closest('article'));

  let candidate: Element | null = null;
  if (articles.length) {
    const biggest = articles.reduce((a, b) => (textLen(b) > textLen(a) ? b : a));
    if (textLen(biggest) >= 0.6 * textLen(scope)) {
      // 1) One article holds most of the content → an article page.
      candidate = biggest;
    } else if (articles.length > 1) {
      // 2) Many small <article>s (cards of a listing page, e.g. PR TIMES company
      //    page): take the container of all of them, not just the first card.
      if (main && articles.every((a) => main.contains(a))) {
        candidate = main;
      } else {
        let common = articles[0]!.parentElement;
        while (common && !articles.every((a) => common!.contains(a))) common = common.parentElement;
        candidate = common || document.body;
      }
    }
  }
  // 3) Semantic main region.
  if (!candidate) candidate = main;

  // 4) Otherwise the container with the most (non-link) text
  if (!candidate) {
    let best: Element | null = null;
    let bestScore = 0;
    const nodes = document.querySelectorAll('div,section,article,main');
    for (const n of nodes) {
      // skip noise
      if (n.closest(NOISE)) continue;
      const len = textLen(n);
      const pCount = n.querySelectorAll('p').length;
      const linkLen = Array.from(n.querySelectorAll('a')).reduce((a, el) => a + textLen(el), 0);
      const linkDensity = len ? linkLen / len : 1;
      // score: lots of text, many <p>, low link density
      const score = len * (1 - linkDensity) + pCount * 50;
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    candidate = best || document.body;
  }

  // Clone, then strip noise (never touch the live page). Keep header/footer/aside that
  // belong to an <article> in the clone (the story's own title header, or each
  // card's header on a listing page).
  const clone = candidate.cloneNode(true) as Element;
  clone.querySelectorAll(NOISE).forEach((el) => {
    const owner = el.parentElement?.closest('article');
    const ownedByArticle =
      owner && (owner === clone || clone.contains(owner)) && /^(HEADER|FOOTER|ASIDE)$/.test(el.tagName);
    if (!ownedByArticle) el.remove();
  });
  clone.querySelectorAll('script,style,noscript,template,svg,iframe').forEach((el) => {
    el.remove();
  });

  result.html = clone.innerHTML;
  return finalize();
}
