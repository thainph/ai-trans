// Full-page translation (top frame only): walks the page's text nodes and
// translates what is in the viewport first; the rest is translated lazily when
// it scrolls near the viewport (IntersectionObserver). Originals are kept in
// `originalTexts` for revert. After a translation a MutationObserver feeds new
// content to the same lazy path. Identical texts are translated once (cache).

import { errorMessage } from '../../../shared/errors';
import { isExtensionAlive } from '../../../shared/runtime';
import { mapLimit } from '../core/map-limit';
import {
  createTextBatches,
  fitsInRequest,
  needsTranslation,
  RateLimiter,
  RetryBudget,
  TranslationCache,
  WeakOriginals,
  withOuterWhitespace,
} from '../core/page-text';
import { isElementVisible, isInViewport } from '../core/visibility';
import { otherTarget } from '../shared/languages';
import { callTranslator, type PageTranslationState } from '../shared/messages';
import { loadSettings, type TranslationStyle } from '../shared/settings';
import { detectLanguage } from './detect-language';
import { LOADING_CSS } from './styles';

interface Langs {
  sourceLang: string;
  targetLang: string;
  style: TranslationStyle;
}

/** Lazy/dynamic translations: debounce, and LLM requests per minute. */
const FLUSH_DELAY_MS = 400;
const MAX_REQUESTS_PER_MINUTE = 20;
/** Texts the model returned nothing usable for are re-queued after this delay. */
const RETRY_DELAY_MS = 2000;
/** Forget garbage-collected originals / detached lazy elements at most this often. */
const PRUNE_INTERVAL_MS = 5000;
/** Pre-translate content this far below/above the viewport. */
const LAZY_MARGIN = '50% 0px';

let pageTranslationState: PageTranslationState = 'idle';
/** Originals for revert (weak: see WeakOriginals). */
const originalTexts = new WeakOriginals<Text>();
/** Bumped on every translate/revert: async work of an older run is dropped. */
let generation = 0;
let langs: Langs | null = null;
let concurrency = 1;
const cache = new TranslationCache();
const retries = new RetryBudget();
let lastPrune = 0;
const limiter = new RateLimiter(MAX_REQUESTS_PER_MINUTE, 60_000);
let loadingHost: HTMLDivElement | null = null;
let loadingShadow: ShadowRoot | null = null;

// Lazy + dynamic pipeline: nodes → IntersectionObserver → pending → flush.
let domObserver: MutationObserver | null = null;
let lazyObserver: IntersectionObserver | null = null;
let lazyTexts = new WeakMap<Element, Set<Text>>();
/** Elements observed by lazyObserver (to unobserve the ones the page removed). */
const lazyElements = new Set<Element>();
const pendingNodes = new Set<Text>();
/** Nodes whose translation is being requested: never sent twice. */
let inFlight = new WeakSet<Text>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

export function getPageTranslationState(): PageTranslationState {
  return pageTranslationState;
}

/** Elements whose text is never translated (and our own widgets). */
const SKIP_SELECTOR = [
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'textarea',
  'input',
  'select',
  'code',
  'pre',
  'kbd',
  'samp',
  '#ai-translator-popup-host',
  '#ai-translator-loading-host',
  '#ai-translator-trigger-host',
].join(',');

/** The single text-node filter (initial walk, lazy and dynamic paths); visibility is checked separately. */
function isCandidate(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  if (originalTexts.has(node) || inFlight.has(node)) return false;
  const text = node.data.trim();
  if (text.length < 2 || !fitsInRequest(text) || !needsTranslation(text)) return false;
  if (retries.exhausted(text)) return false;
  if (parent.isContentEditable) return false;
  return !parent.closest(SKIP_SELECTOR);
}

function collectTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isCandidate(node as Text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

const isVisibleText = (node: Text) => !!node.parentElement && isElementVisible(node.parentElement);

async function requestBatch(texts: string[], l: Langs): Promise<(string | null)[]> {
  const response = await callTranslator({ type: 'translate-batch', texts, ...l });
  if (response?.ok && response.translations.length === texts.length) return response.translations;
  throw new Error((response && !response.ok && response.error) || 'Translation failed');
}

function applyTranslation(node: Text, source: string, translation: string): void {
  // The page changed the text meanwhile → leave it alone.
  if (node.data.trim() !== source || originalTexts.has(node)) return;
  originalTexts.set(node, node.data);
  if (translation !== source) node.data = withOuterWhitespace(node.data, translation);
}

interface Leftovers {
  /** Not sent: over the rate cap. */
  deferred: Text[];
  /** Sent, but the model returned nothing usable (still within the retry budget). */
  retry: Text[];
}

/**
 * Translate `nodes`: cached texts at once, the other distinct texts in batches
 * through a bounded pool. With `limiter`, batches over the rate cap are not
 * sent. Items without a usable translation are neither cached nor marked as
 * translated. Returns the nodes the caller should queue again.
 */
async function translateNodes(
  nodes: Text[],
  l: Langs,
  gen: number,
  opts: { limiter?: RateLimiter; onProgress?: (done: number, total: number) => void } = {},
): Promise<Leftovers> {
  const bySource = new Map<string, Text[]>();
  for (const node of nodes) {
    const source = node.data.trim();
    const cached = cache.get(source);
    if (cached !== undefined) {
      applyTranslation(node, source, cached);
      continue;
    }
    inFlight.add(node);
    const group = bySource.get(source);
    if (group) group.push(node);
    else bySource.set(source, [node]);
  }

  const batches = createTextBatches([...bySource.keys()]);
  const deferred: Text[] = [];
  const retry: Text[] = [];
  let done = 0;
  let stopped = false;
  try {
    await mapLimit(batches, concurrency, async (batch) => {
      if (stopped || gen !== generation) return;
      if (opts.limiter && !opts.limiter.tryAcquire()) {
        for (const source of batch) deferred.push(...bySource.get(source)!);
        return;
      }
      let translations: (string | null)[];
      try {
        translations = await requestBatch(batch, l);
      } catch (err) {
        stopped = true;
        throw err;
      }
      if (gen !== generation) return;
      batch.forEach((source, i) => {
        const translation = translations[i];
        if (translation == null) {
          if (retries.fail(source)) retry.push(...bySource.get(source)!);
          return;
        }
        cache.set(source, translation);
        for (const node of bySource.get(source)!) applyTranslation(node, source, translation);
      });
      opts.onProgress?.(++done, batches.length);
    });
  } finally {
    for (const node of nodes) inFlight.delete(node);
  }
  return { deferred, retry };
}

/** Queue leftovers for a later flush (rate cap → when a slot frees up; retries → after a pause). */
function requeue({ deferred, retry }: Leftovers): void {
  for (const node of [...deferred, ...retry]) pendingNodes.add(node);
  if (deferred.length > 0) scheduleFlush(Math.max(limiter.waitMs(), FLUSH_DELAY_MS));
  else if (retry.length > 0) scheduleFlush(RETRY_DELAY_MS);
}

export async function translatePage(): Promise<void> {
  if (!isExtensionAlive()) return;
  if (pageTranslationState === 'translating') return;

  const settings = await loadSettings('apiKey', 'geminiApiKey', 'targetLang', 'style', 'provider');
  if (settings.provider === 'openai' && !settings.apiKey) {
    showLoadingError('No API key set. Open extension settings.');
    return;
  }
  if (settings.provider === 'gemini' && !settings.geminiApiKey) {
    showLoadingError('No Gemini API key set. Open extension settings.');
    return;
  }

  stopObservers();
  const gen = ++generation;
  pageTranslationState = 'translating';
  showLoading();

  const textNodes = collectTextNodes(document.body).filter(isVisibleText);
  if (textNodes.length === 0) {
    pageTranslationState = originalTexts.size > 0 ? 'translated' : 'idle';
    hideLoading();
    return;
  }

  // Detect source language from page sample
  const sourceLang = detectLanguage(
    textNodes
      .slice(0, 10)
      .map((n) => n.data)
      .join(' '),
  );
  let targetLang = settings.targetLang;
  if (targetLang === sourceLang) {
    targetLang = otherTarget(sourceLang);
  }
  const l: Langs = { sourceLang, targetLang, style: settings.style };
  langs = l;
  concurrency = settings.provider === 'ollama' ? 2 : 5;
  cache.use(`${sourceLang}|${targetLang}|${settings.style}`);
  retries.clear();

  // Viewport first; the rest when it gets close (and content added later).
  const inView = new Set(textNodes.filter((n) => isInViewport(n.parentElement!)));
  startObservers();
  observeLazily(textNodes.filter((n) => !inView.has(n)));

  try {
    const leftovers = await translateNodes([...inView], l, gen, {
      onProgress: (done, total) => showLoading(`Translating... ${done}/${total}`),
    });
    if (gen === generation) requeue(leftovers);
  } catch (err) {
    if (gen !== generation) return;
    console.warn('AI Translator: batch failed', errorMessage(err));
    showLoadingError(`Error: ${errorMessage(err)}`);
    stopObservers();
    pageTranslationState = originalTexts.size > 0 ? 'translated' : 'idle';
    return;
  }
  if (gen !== generation) return;
  hideLoading();
  pageTranslationState = 'translated';
}

export function revertPageTranslation(): void {
  generation++;
  stopObservers();
  hideLoading();
  originalTexts.restoreAll((node, original) => {
    node.data = original;
  });
  langs = null;
  pageTranslationState = 'idle';
}

// --- Lazy (IntersectionObserver) + dynamic (MutationObserver) content ---

function startObservers(): void {
  lazyObserver = new IntersectionObserver(onIntersect, { rootMargin: LAZY_MARGIN });
  domObserver = new MutationObserver((mutations) => {
    const nodes: Text[] = [];
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.TEXT_NODE) {
          if (isCandidate(added as Text)) nodes.push(added as Text);
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          nodes.push(...collectTextNodes(added));
        }
      }
    }
    observeLazily(nodes);
  });
  domObserver.observe(document.body, { childList: true, subtree: true });
}

function stopObservers(): void {
  domObserver?.disconnect();
  domObserver = null;
  lazyObserver?.disconnect();
  lazyObserver = null;
  lazyTexts = new WeakMap();
  lazyElements.clear();
  inFlight = new WeakSet();
  pendingNodes.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

/** Translate these nodes once their element comes near the viewport. */
function observeLazily(nodes: Text[]): void {
  if (!lazyObserver) return;
  for (const node of nodes) {
    const el = node.parentElement!;
    const set = lazyTexts.get(el);
    if (set) {
      set.add(node);
    } else {
      lazyTexts.set(el, new Set([node]));
      lazyElements.add(el);
      lazyObserver.observe(el);
    }
  }
}

function unobserveLazy(el: Element): void {
  lazyObserver?.unobserve(el);
  lazyElements.delete(el);
  lazyTexts.delete(el);
}

/**
 * SPAs replace content all the time: stop observing removed elements (the
 * observer holds them strongly) and forget collected originals. Throttled.
 */
function pruneDetached(): void {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  for (const el of lazyElements) if (!el.isConnected) unobserveLazy(el);
  originalTexts.prune();
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    for (const node of lazyTexts.get(entry.target) ?? []) pendingNodes.add(node);
    unobserveLazy(entry.target);
  }
  pruneDetached();
  if (pendingNodes.size > 0) scheduleFlush(FLUSH_DELAY_MS);
}

function scheduleFlush(delay: number): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingNodes();
  }, delay);
}

/** One flush at a time; nodes queued meanwhile are handled by the next one. */
async function flushPendingNodes(): Promise<void> {
  if (flushing || !langs) return;
  if (!isExtensionAlive()) {
    stopObservers();
    return;
  }
  const gen = generation;
  pruneDetached();
  const nodes = [...pendingNodes].filter((n) => n.isConnected && isCandidate(n) && isVisibleText(n));
  pendingNodes.clear();
  if (nodes.length === 0) return;

  flushing = true;
  try {
    const leftovers = await translateNodes(nodes, langs, gen, { limiter });
    if (gen === generation) requeue(leftovers);
  } catch (err) {
    console.warn('AI Translator: dynamic translate failed', errorMessage(err));
  } finally {
    flushing = false;
    if (gen === generation && pendingNodes.size > 0) scheduleFlush(FLUSH_DELAY_MS);
  }
}

// --- Loading Indicator ---
function showLoading(progress?: string): void {
  if (!loadingHost) {
    loadingHost = document.createElement('div');
    loadingHost.id = 'ai-translator-loading-host';
    loadingShadow = loadingHost.attachShadow({ mode: 'closed' });
    loadingShadow.innerHTML = `
      <style>${LOADING_CSS}</style>
      <div class="loading-bar">
        <div class="spinner"></div>
        <span id="loadingText">Translating...</span>
      </div>
    `;
    document.body.appendChild(loadingHost);
  }
  const text = loadingShadow?.getElementById('loadingText');
  if (text) text.textContent = progress || 'Translating...';
}

function hideLoading(): void {
  if (loadingHost) {
    loadingHost.remove();
    loadingHost = null;
    loadingShadow = null;
  }
}

function showLoadingError(msg: string): void {
  if (!loadingHost) {
    showLoading();
  }
  const bar = loadingShadow?.querySelector<HTMLElement>('.loading-bar');
  const spinner = loadingShadow?.querySelector<HTMLElement>('.spinner');
  const text = loadingShadow?.getElementById('loadingText');
  if (bar) bar.style.background = '#7f1d1d';
  if (spinner) spinner.style.display = 'none';
  if (text) text.textContent = msg;
  setTimeout(hideLoading, 5000);
}
