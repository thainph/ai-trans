// Full-page translation: walks the page's text nodes, translates them in
// batches and keeps the originals (`originalTexts`) for revert. After a
// translation a MutationObserver translates content added later.

import { errorMessage } from '../../../shared/errors';
import { isExtensionAlive } from '../../../shared/runtime';
import { otherTarget } from '../shared/languages';
import { callTranslator, type PageTranslationState } from '../shared/messages';
import { loadSettings, type TranslationStyle } from '../shared/settings';
import { detectLanguage } from './detect-language';
import { LOADING_CSS } from './styles';

let pageTranslationState: PageTranslationState = 'idle';
const originalTexts = new Map<Text, string>();
let translationCancelled = false;
let loadingHost: HTMLDivElement | null = null;
let loadingShadow: ShadowRoot | null = null;
let domObserver: MutationObserver | null = null;
let pendingNewNodes: Text[] = [];
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastTranslationLangs: { sourceLang: string; targetLang: string; style: TranslationStyle } | null = null;

export function getPageTranslationState(): PageTranslationState {
  return pageTranslationState;
}

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'SVG',
  'CANVAS',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
]);

/** Our own widgets are never translated. */
const OWN_UI = '#ai-translator-popup-host, #ai-translator-loading-host, .ai-translator-trigger-container';

// New filter logic must go in both collectTranslatableTextNodes() and isTranslatableTextNode().
function collectTranslatableTextNodes(): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (parent.closest(OWN_UI)) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = (node.textContent ?? '').trim();
      if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
      if (!needsTranslation(text)) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text);
  }
  return nodes;
}

// Skip text that doesn't need translation
function needsTranslation(text: string): boolean {
  if (/^\d[\d\s.,:%/\-+()]*$/.test(text)) return false; // numbers only
  if (/^https?:\/\/\S+$/.test(text)) return false; // URLs
  if (/^[^a-zA-ZÀ-ɏЀ-ӿ؀-ۿऀ-ॿ฀-๿぀-ヿ一-鿿가-힯]+$/.test(text)) return false; // no letters at all
  return true;
}

function createBatches(textNodes: Text[], maxChars = 3000): Text[][] {
  const batches: Text[][] = [];
  let current: Text[] = [];
  let currentLen = 0;
  for (const node of textNodes) {
    const text = (node.textContent ?? '').trim();
    if (currentLen + text.length > maxChars && current.length > 0) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(node);
    currentLen += text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function requestBatch(
  texts: string[],
  sourceLang: string,
  targetLang: string,
  style: TranslationStyle,
): Promise<string[]> {
  const response = await callTranslator({ type: 'translate-batch', texts, sourceLang, targetLang, style });
  if (response?.ok) return response.translations;
  throw new Error((response && !response.ok && response.error) || 'Translation failed');
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

  pageTranslationState = 'translating';
  translationCancelled = false;
  originalTexts.clear();
  showLoading();

  const textNodes = collectTranslatableTextNodes();
  if (textNodes.length === 0) {
    pageTranslationState = 'idle';
    hideLoading();
    return;
  }

  const batches = createBatches(textNodes);
  const totalBatches = batches.length;

  // Detect source language from page sample
  const sampleText = textNodes
    .slice(0, 10)
    .map((n) => n.textContent)
    .join(' ');
  const sourceLang = detectLanguage(sampleText);
  let targetLang = settings.targetLang;
  if (targetLang === sourceLang) {
    targetLang = otherTarget(sourceLang);
  }

  const CONCURRENCY = settings.provider === 'ollama' ? 2 : 5;
  let completed = 0;
  let failed = false;

  const translateBatch = (batch: Text[]) =>
    requestBatch(
      batch.map((n) => (n.textContent ?? '').trim()),
      sourceLang,
      targetLang,
      settings.style,
    );

  function applyBatchResult(batch: Text[], result: string[]): void {
    for (let j = 0; j < batch.length; j++) {
      const node = batch[j]!;
      if (!originalTexts.has(node)) {
        originalTexts.set(node, node.textContent ?? '');
      }
      if (result[j]) {
        node.textContent = result[j]!;
      }
    }
  }

  // Process batches with concurrency limit
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    if (translationCancelled || failed) break;

    const chunk = batches.slice(i, i + CONCURRENCY);
    const promises = chunk.map((batch) => translateBatch(batch));

    try {
      const results = await Promise.all(promises);
      results.forEach((result, idx) => {
        applyBatchResult(chunk[idx]!, result);
      });
      completed += chunk.length;
      showLoading(`Translating... ${completed}/${totalBatches}`);
    } catch (err) {
      console.warn('AI Translator: batch failed', errorMessage(err));
      showLoadingError(`Error: ${errorMessage(err)}`);
      pageTranslationState = originalTexts.size > 0 ? 'translated' : 'idle';
      failed = true;
    }
  }

  if (failed) return;

  hideLoading();

  if (translationCancelled) {
    pageTranslationState = originalTexts.size > 0 ? 'translated' : 'idle';
  } else {
    pageTranslationState = 'translated';
  }

  if (pageTranslationState === 'translated') {
    lastTranslationLangs = { sourceLang, targetLang, style: settings.style };
    startDomObserver();
  }
}

export function revertPageTranslation(): void {
  stopDomObserver();
  for (const [node, original] of originalTexts) {
    try {
      node.textContent = original;
    } catch {
      // Node may have been removed from DOM
    }
  }
  originalTexts.clear();
  lastTranslationLangs = null;
  pageTranslationState = 'idle';
}

// --- MutationObserver for dynamic content ---
function isTranslatableTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  if (SKIP_TAGS.has(parent.tagName)) return false;
  if (parent.isContentEditable) return false;
  if (parent.closest(OWN_UI)) return false;
  const text = (node.textContent ?? '').trim();
  if (text.length < 2) return false;
  if (!needsTranslation(text)) return false;
  if (originalTexts.has(node)) return false;
  return true;
}

function collectNewTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return isTranslatableTextNode(node as Text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

function startDomObserver(): void {
  if (domObserver) return;
  domObserver = new MutationObserver((mutations) => {
    if (pageTranslationState !== 'translated') return;

    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.TEXT_NODE) {
          if (isTranslatableTextNode(added as Text)) pendingNewNodes.push(added as Text);
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          pendingNewNodes.push(...collectNewTextNodes(added));
        }
      }
    }

    if (pendingNewNodes.length > 0 && !pendingTimer) {
      pendingTimer = setTimeout(flushPendingNodes, 500);
    }
  });

  domObserver.observe(document.body, { childList: true, subtree: true });
}

function stopDomObserver(): void {
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
  pendingNewNodes = [];
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}

async function flushPendingNodes(): Promise<void> {
  pendingTimer = null;
  const nodes = pendingNewNodes.filter(
    (n) => n.isConnected && !originalTexts.has(n) && (n.textContent ?? '').trim().length >= 2,
  );
  pendingNewNodes = [];
  if (nodes.length === 0 || !lastTranslationLangs || !isExtensionAlive()) return;

  const { sourceLang, targetLang, style } = lastTranslationLangs;
  const batches = createBatches(nodes);

  for (const batch of batches) {
    const texts = batch.map((n) => (n.textContent ?? '').trim());
    try {
      const result = await requestBatch(texts, sourceLang, targetLang, style);
      for (let j = 0; j < batch.length; j++) {
        const node = batch[j]!;
        if (!originalTexts.has(node)) originalTexts.set(node, node.textContent ?? '');
        if (result[j]) node.textContent = result[j]!;
      }
    } catch (err) {
      console.warn('AI Translator: dynamic translate failed', errorMessage(err));
    }
  }
}

// --- Loading Indicator ---
function showLoading(progress?: string): void {
  if (!loadingHost) {
    loadingHost = document.createElement('div');
    loadingHost.id = 'ai-translator-loading-host';
    loadingShadow = loadingHost.attachShadow({ mode: 'open' });
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
