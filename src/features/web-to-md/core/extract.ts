// extractInPage(mode) runs inside the page via chrome.scripting.executeScript
// ({ func: extractInPage }), so it must stay SELF-CONTAINED: no imports, no
// outer variables (type-only imports are fine). Returns plain data only.
// Unit-tested in tests/web-extract.test.ts.

export type ExtractMode = 'article' | 'full' | 'selection';

export interface ExtractResult {
  title: string;
  url: string;
  description: string;
  byline: string;
  siteName: string;
  published: string;
  html: string;
  /** Length of the extracted text (whitespace collapsed). */
  textLen: number;
  isTop: boolean;
  host: string;
  mode: ExtractMode;
  /** Host of a Claude artifact's real content (claudeusercontent.com iframe), or "". */
  uchost: string;
  /** Selected plain text ("selection" mode). */
  text?: string;
}

export function extractInPage(mode: ExtractMode): ExtractResult {
  const meta = (name: string) => {
    const el = document.querySelector(`meta[property="${name}"]`) || document.querySelector(`meta[name="${name}"]`);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };

  const result: ExtractResult = {
    title: (meta('og:title') || document.title || '').trim(),
    url: location.href,
    description: meta('description') || meta('og:description') || '',
    byline: meta('author') || meta('article:author') || '',
    siteName: meta('og:site_name') || location.hostname,
    published: meta('article:published_time') || '',
    html: '',
    textLen: 0,
    isTop: window.top === window.self,
    host: location.hostname,
    mode: mode,
    uchost: '',
  };

  // Host of a Claude artifact's real content (claudeusercontent.com iframe)
  const slot = document.querySelector('[data-frame-uchost]');
  result.uchost = slot?.getAttribute('data-frame-uchost') || '';

  const finalize = () => {
    const tmp = document.createElement('div');
    tmp.innerHTML = result.html || '';
    result.textLen = (tmp.textContent || '').replace(/\s+/g, ' ').trim().length;
    return result;
  };

  // Selection mode
  if (mode === 'selection') {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
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
