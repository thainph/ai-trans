// Translator content script (every page, every frame): the floating selection
// toolbar (T translate, G grammar, R reverse, ➤ send to Devdy), the result
// popup (Shadow DOM — query it via `shadowRoot`, not `document`) and the
// full-page translation commands sent by the popup.

import { errorMessage } from '../../../shared/errors';
import { onTargetMessage, type Result } from '../../../shared/messaging';
import { isExtensionAlive } from '../../../shared/runtime';
import { sendSelection } from '../../web-to-md/content/send-selection';
import { isLanguageId, LANGUAGES, otherTarget } from '../shared/languages';
import {
  callTranslator,
  type PageStateResponse,
  TRANSLATOR_PAGE_TARGET,
  type TranslatorPageRequest,
} from '../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type TranslationStyle } from '../shared/settings';
import { detectLanguage } from './detect-language';
import { getPageTranslationState, revertPageTranslation, translatePage } from './page-translation';
import { POPUP_CSS } from './styles';
import './content.css';

type TextControl = HTMLInputElement | HTMLTextAreaElement;

let triggerBtn: HTMLDivElement | null = null;
let popupHost: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let currentSelection = '';
let lastDetectedSourceLang: string | null = null;

// --- Selection context ---
// Captured at mouseup because opening the popup / clicking a button collapses
// the live selection. Form controls (input/textarea) expose their selection
// through selectionStart/End, NOT window.getSelection(), so they need a
// separate path from normal/contenteditable selections.
let selFormControl: TextControl | null = null; // INPUT/TEXTAREA element, or null
let selStart = 0;
let selEnd = 0;
let selRange: Range | null = null; // cloned Range (normal / contenteditable)
let selRect: DOMRect | null = null; // rect used to anchor trigger + popup
let selAnchorEl: Element | null = null; // nearest element (editability check)

// --- Grammar replace target (snapshot taken when G is clicked) ---
let grammarFormControl: TextControl | null = null; // INPUT/TEXTAREA to write back into
let grammarEditable: Element | null = null; // contenteditable node to write back into
let grammarRange: Range | null = null; // cloned Range (contenteditable)
let grammarStart = 0;
let grammarEnd = 0;

function cleanup(): void {
  removeTrigger();
  removePopup();
}

// --- Helper: check if element is editable ---
function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

// Text-like form controls whose selection we can read/write (skip password, etc.)
function isTextInput(el: Element | null): el is TextControl {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return ['text', 'search', 'url', 'email', 'tel'].includes(t);
  }
  return false;
}

// --- Trigger Button ---
function triggerButton(className: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = `ai-translator-trigger ${className}`;
  btn.title = title;
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function showTrigger(rect: DOMRect, anchorEl: Element | null): void {
  removeTrigger();

  const container = document.createElement('div');
  container.className = 'ai-translator-trigger-container';

  const isEditable = isEditableElement(anchorEl);

  // Always create the translate button
  const tBtn = triggerButton('ai-translator-trigger-translate', 'Translate', onTriggerClick);
  tBtn.textContent = 'T';
  container.appendChild(tBtn);

  // Grammar check — only in editable fields (correct the text you are writing)
  if (isEditable) {
    const gBtn = triggerButton('ai-translator-trigger-grammar', 'Check English Grammar', onGrammarClick);
    gBtn.textContent = 'G';
    container.appendChild(gBtn);
  }

  // Send the selection to Devdy — page text only (not what you are typing).
  if (!isEditable) {
    const dBtn = triggerButton('ai-translator-trigger-devdy', 'Send selection to Devdy', onDevdyClick);
    dBtn.setAttribute('aria-label', 'Send selection to Devdy');
    dBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    container.appendChild(dBtn);
  }

  // Show reverse button if editable + has previous source lang
  const showReverse = isEditable && lastDetectedSourceLang !== null;
  if (showReverse) {
    const rBtn = triggerButton('ai-translator-trigger-reverse', 'Reverse Translate', onReverseTriggerClick);
    rBtn.textContent = 'R';
    container.appendChild(rBtn);
  }

  const btnCount = container.childElementCount;
  if (btnCount === 1) container.classList.add('single');

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const btnSize = 34;
  const totalWidth = btnSize * btnCount;
  const containerHeight = btnSize;
  const gap = 6;
  const spaceBelow = window.innerHeight - rect.bottom;

  container.style.left = `${rect.left + scrollX + rect.width / 2 - totalWidth / 2}px`;
  if (spaceBelow < containerHeight + gap) {
    container.style.top = `${rect.top + scrollY - containerHeight - gap}px`;
  } else {
    container.style.top = `${rect.bottom + scrollY + gap}px`;
  }

  triggerBtn = container;
  document.body.appendChild(container);
}

function removeTrigger(): void {
  if (triggerBtn) {
    triggerBtn.remove();
    triggerBtn = null;
  }
}

// --- Build target language <option> list ---
function buildLangOptions(selectedLang: string): string {
  return Object.entries(LANGUAGES)
    .map(([key, { label, name }]) => {
      const sel = key === selectedLang ? ' selected' : '';
      return `<option value="${key}"${sel}>${label} - ${name}</option>`;
    })
    .join('');
}

// --- Popup (Shadow DOM) ---
function createPopup(
  rect: DOMRect,
  sourceLang: string,
  targetLang: string,
  mode: 'translate' | 'grammar' = 'translate',
) {
  if (!isExtensionAlive()) {
    cleanup();
    return;
  }
  removePopup();

  const host = document.createElement('div');
  popupHost = host;
  host.id = 'ai-translator-popup-host';
  host.style.cssText = 'position:absolute;z-index:2147483647;';

  const isGrammar = mode === 'grammar';
  const sourceLabel = isLanguageId(sourceLang) ? LANGUAGES[sourceLang].label : '?';
  const headerInner = isGrammar
    ? `<div class="lang-pair">
          <span class="lang-badge source">EN</span>
          <span class="grammar-label">Grammar</span>
        </div>`
    : `<div class="lang-pair">
          <span class="lang-badge source">${sourceLabel}</span>
          <span class="arrow">→</span>
          <select class="lang-select" id="targetSelect">${buildLangOptions(targetLang)}</select>
        </div>`;
  const footerInner = isGrammar
    ? `<button class="copy-btn" id="copyBtn" disabled>Copy</button>
       <button class="replace-btn" id="replaceBtn" disabled>Replace</button>`
    : `<button class="copy-btn" id="copyBtn" disabled>Copy</button>
       <select class="style-select" id="styleSelect">
          <option value="casual">Casual</option>
          <option value="polite">Polite</option>
          <option value="business">Business</option>
        </select>`;
  const loadingLabel = isGrammar ? 'Checking...' : 'Translating...';

  const root = host.attachShadow({ mode: 'open' });
  shadowRoot = root;
  root.innerHTML = `
    <style>${POPUP_CSS}</style>
    <div class="popup">
      <div class="resize-handle resize-left"></div>
      <div class="resize-handle resize-right"></div>
      <div class="resize-handle resize-top"></div>
      <div class="resize-handle resize-bottom"></div>
      <div class="header">
        ${headerInner}
        <button class="close-btn" id="closeBtn">✕</button>
      </div>
      <div class="result" id="result">
        <div class="loading"><span class="spinner"></span> ${loadingLabel}</div>
      </div>
      <div class="footer">
        ${footerInner}
      </div>
    </div>
  `;

  // Apply saved width (height applied after maxHeight is computed below)
  const popup = root.querySelector<HTMLElement>('.popup')!;

  // Position popup
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const popupWidth = DEFAULT_SETTINGS.popupWidth;
  const gap = 10;
  const headerFooterHeight = 90; // approximate header + footer height
  const minResultHeight = 80;

  let left = rect.left + scrollX;
  if (left + popupWidth > window.innerWidth + scrollX) {
    left = window.innerWidth + scrollX - popupWidth - gap;
  }
  if (left < scrollX) left = scrollX + gap;

  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const showAbove = spaceBelow < headerFooterHeight + minResultHeight + gap && spaceAbove > spaceBelow;
  const availableSpace = showAbove ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(availableSpace - gap * 2, headerFooterHeight + minResultHeight);

  // Set dynamic max-height via CSS variable
  popup.style.setProperty('--popup-max-height', `${maxHeight}px`);

  // Apply saved width + height (clamp height to available space)
  void loadSettings('popupWidth', 'popupHeight').then((data) => {
    popup.style.setProperty('--popup-width', `${data.popupWidth}px`);
    if (data.popupHeight > 0) {
      const clamped = Math.min(data.popupHeight, maxHeight);
      popup.style.setProperty('--popup-height', `${clamped}px`);
      popup.style.setProperty('--popup-max-height', `${clamped}px`);
    }
  });

  let top: number;
  if (showAbove) {
    top = rect.top + scrollY - maxHeight - gap;
    if (top < scrollY) top = scrollY + gap;
  } else {
    top = rect.bottom + scrollY + gap;
  }

  host.style.left = `${left}px`;
  host.style.top = `${top}px`;

  document.body.appendChild(host);

  // Adjust position after render using actual height
  requestAnimationFrame(() => {
    if (!shadowRoot) return;
    const popupEl = shadowRoot.querySelector<HTMLElement>('.popup');
    if (!popupEl) return;
    const actualHeight = popupEl.offsetHeight;
    if (showAbove) {
      const adjustedTop = rect.top + scrollY - actualHeight - gap;
      host.style.top = `${Math.max(adjustedTop, scrollY + gap)}px`;
    }
  });

  // Event listeners
  root.getElementById('closeBtn')!.addEventListener('click', removePopup);

  root.getElementById('copyBtn')!.addEventListener('click', () => {
    const resultEl = root.getElementById('result')!;
    const text = resultEl.textContent ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      const btn = root.getElementById('copyBtn')!;
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1500);
    });
  });

  if (isGrammar) {
    // Replace → write the corrected text back into the editable field
    root.getElementById('replaceBtn')!.addEventListener('click', () => {
      const resultEl = root.getElementById('result')!;
      applyGrammarReplace(resultEl.textContent ?? '');
    });
  } else {
    // Load saved style
    void loadSettings('style').then((data) => {
      const select = shadowRoot?.getElementById('styleSelect') as HTMLSelectElement | null | undefined;
      if (select) select.value = data.style;
    });

    // Target language change → re-translate
    root.getElementById('targetSelect')!.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value;
      void saveSettings({ targetLang: value });
      translate(currentSelection, sourceLang, value);
    });

    // Style change → re-translate
    root.getElementById('styleSelect')!.addEventListener('change', (e) => {
      void saveSettings({ style: (e.target as HTMLSelectElement).value as TranslationStyle });
      const targetSel = root.getElementById('targetSelect') as HTMLSelectElement;
      translate(currentSelection, sourceLang, targetSel.value);
    });
  }

  // Resize handles
  setupResizeHandle(root.querySelector('.resize-right')!, 'right');
  setupResizeHandle(root.querySelector('.resize-left')!, 'left');
  setupResizeHandle(root.querySelector('.resize-top')!, 'top');
  setupResizeHandle(root.querySelector('.resize-bottom')!, 'bottom');

  // Drag handle (header)
  setupDragHandle(root.querySelector('.header')!);
}

function setupResizeHandle(handle: Element, side: 'left' | 'right' | 'top' | 'bottom'): void {
  const minWidth = 240;
  const maxWidth = 600;
  const minHeight = 120;
  const isVertical = side === 'top' || side === 'bottom';

  handle.addEventListener('mousedown', (ev) => {
    const e = ev as MouseEvent;
    e.preventDefault();
    e.stopPropagation();
    const host = popupHost;
    const popup = shadowRoot?.querySelector<HTMLElement>('.popup');
    if (!host || !popup) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = popup.offsetWidth;
    const startHeight = popup.offsetHeight;
    const startLeft = host.offsetLeft;
    const startTop = host.offsetTop;
    const maxHeight = Math.max(window.innerHeight - 40, minHeight);

    function onMouseMove(e: MouseEvent): void {
      if (!host || !popup) return;
      if (isVertical) {
        const delta = e.clientY - startY;
        let newHeight: number;
        if (side === 'bottom') {
          newHeight = Math.min(maxHeight, Math.max(minHeight, startHeight + delta));
        } else {
          newHeight = Math.min(maxHeight, Math.max(minHeight, startHeight - delta));
          host.style.top = `${startTop + (startHeight - newHeight)}px`;
        }
        popup.style.setProperty('--popup-height', `${newHeight}px`);
        popup.style.setProperty('--popup-max-height', `${newHeight}px`);
      } else {
        const delta = e.clientX - startX;
        let newWidth: number;
        if (side === 'right') {
          newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
        } else {
          newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth - delta));
          host.style.left = `${startLeft + (startWidth - newWidth)}px`;
        }
        popup.style.setProperty('--popup-width', `${newWidth}px`);
      }
    }

    function onMouseUp(): void {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (!popup) return;
      if (isVertical) {
        void saveSettings({ popupHeight: popup.offsetHeight });
      } else {
        void saveSettings({ popupWidth: popup.offsetWidth });
      }
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function setupDragHandle(header: HTMLElement): void {
  header.addEventListener('mousedown', (e) => {
    // Don't drag when clicking on buttons or selects
    if ((e.target as Element).closest('button, select')) return;
    e.preventDefault();
    e.stopPropagation();
    const host = popupHost;
    if (!host) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = host.offsetLeft;
    const startTop = host.offsetTop;

    header.style.cursor = 'grabbing';

    function onMouseMove(e: MouseEvent): void {
      if (!host) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      host.style.left = `${startLeft + dx}px`;
      host.style.top = `${startTop + dy}px`;
    }

    function onMouseUp(): void {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      header.style.cursor = '';
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function removePopup(): void {
  if (popupHost) {
    popupHost.remove();
    popupHost = null;
    shadowRoot = null;
  }
}

function showResult(text: string): void {
  if (!shadowRoot) return;
  const resultEl = shadowRoot.getElementById('result')!;
  resultEl.textContent = text;
  const copyBtn = shadowRoot.getElementById('copyBtn') as HTMLButtonElement;
  copyBtn.disabled = false;
  const replaceBtn = shadowRoot.getElementById('replaceBtn') as HTMLButtonElement | null;
  if (replaceBtn) replaceBtn.disabled = false;
}

function showError(msg: string): void {
  if (!shadowRoot) return;
  const resultEl = shadowRoot.getElementById('result')!;
  resultEl.innerHTML = `<div class="error">${escapeHtml(msg)}</div>`;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Show a background response in the popup: the payload, or its error / a runtime error. */
function showResponse<T extends object>(
  request: Promise<Result<T> | undefined>,
  pick: (value: T) => string,
  failure: string,
): void {
  request.then(
    (response) => {
      if (response?.ok) showResult(pick(response));
      else showError((response && !response.ok && response.error) || failure);
    },
    (err: unknown) => showError(errorMessage(err)),
  );
}

// --- Translation ---
function translate(text: string, sourceLang: string, targetLang: string): void {
  if (!shadowRoot) return;
  if (!isExtensionAlive()) {
    cleanup();
    return;
  }
  const resultEl = shadowRoot.getElementById('result')!;
  resultEl.innerHTML = `<div class="loading"><span class="spinner"></span> Translating...</div>`;
  const copyBtn = shadowRoot.getElementById('copyBtn') as HTMLButtonElement;
  copyBtn.disabled = true;

  void loadSettings('style').then(({ style }) => {
    showResponse(
      callTranslator({ type: 'translate', text, sourceLang, targetLang, style }),
      (r) => r.translation,
      'Translation failed',
    );
  });
}

// --- Grammar Check ---
function checkGrammar(text: string): void {
  if (!shadowRoot) return;
  if (!isExtensionAlive()) {
    cleanup();
    return;
  }
  const resultEl = shadowRoot.getElementById('result')!;
  resultEl.innerHTML = `<div class="loading"><span class="spinner"></span> Checking...</div>`;
  const copyBtn = shadowRoot.getElementById('copyBtn') as HTMLButtonElement | null;
  if (copyBtn) copyBtn.disabled = true;
  const replaceBtn = shadowRoot.getElementById('replaceBtn') as HTMLButtonElement | null;
  if (replaceBtn) replaceBtn.disabled = true;

  showResponse(callTranslator({ type: 'grammar-check', text }), (r) => r.corrected, 'Grammar check failed');
}

function onGrammarClick(): void {
  if (!isExtensionAlive()) {
    cleanup();
    return;
  }
  const text = currentSelection;
  if (!text || !selRect) return;

  // Snapshot the replace target — opening the popup collapses the selection.
  if (selFormControl) {
    grammarFormControl = selFormControl;
    grammarEditable = null;
    grammarRange = null;
    grammarStart = selStart;
    grammarEnd = selEnd;
  } else {
    grammarFormControl = null;
    grammarEditable = selAnchorEl;
    grammarRange = selRange ? selRange.cloneRange() : null;
  }

  removeTrigger();

  createPopup(selRect, 'english', 'english', 'grammar');
  checkGrammar(text);
}

// Set a form control's value via the native setter so React (and similar
// controlled components) register the change instead of overwriting it.
function setNativeValue(el: TextControl, value: string): void {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function applyGrammarReplace(corrected: string): void {
  try {
    if (grammarFormControl) {
      const fc = grammarFormControl;
      fc.focus();
      const value = fc.value;
      setNativeValue(fc, value.slice(0, grammarStart) + corrected + value.slice(grammarEnd));
      const caret = grammarStart + corrected.length;
      fc.setSelectionRange(caret, caret);
      fc.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (grammarEditable) {
      // Focus the contenteditable host, not a child node (spans aren't focusable)
      const host = (grammarEditable.closest?.('[contenteditable]') || grammarEditable) as HTMLElement;
      host.focus?.();
      if (grammarRange) {
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(grammarRange);
      }
      // execCommand triggers proper input events for framework-managed editors
      const ok = document.execCommand('insertText', false, corrected);
      if (!ok && grammarRange) {
        grammarRange.deleteContents();
        grammarRange.insertNode(document.createTextNode(corrected));
        host.dispatchEvent?.(new Event('input', { bubbles: true }));
      }
    } else {
      removePopup();
      return;
    }
  } catch (err) {
    console.warn('AI Translator: grammar replace failed', errorMessage(err));
  }

  grammarFormControl = null;
  grammarEditable = null;
  grammarRange = null;
  removePopup();
}

/** Open the popup and translate, avoiding source == target. */
function translateWithSavedTarget(text: string, rect: DOMRect, sourceLang: string): void {
  void loadSettings('targetLang').then((data) => {
    let targetLang = data.targetLang;
    // If source and target are the same, switch to english (or vietnamese)
    if (targetLang === sourceLang) {
      targetLang = otherTarget(sourceLang);
    }
    createPopup(rect, sourceLang, targetLang);
    translate(text, sourceLang, targetLang);
  });
}

function onTriggerClick(): void {
  if (!isExtensionAlive()) {
    cleanup();
    return;
  }
  const text = currentSelection;
  if (!text || !selRect) return;

  const rect = selRect;

  removeTrigger();

  const sourceLang = detectLanguage(text);
  lastDetectedSourceLang = sourceLang;

  translateWithSavedTarget(text, rect, sourceLang);
}

function onDevdyClick(): void {
  if (!isExtensionAlive()) {
    cleanup();
    return;
  }
  const text = currentSelection;
  const range = selRange;
  if (!text || !range) return;
  removeTrigger();
  void sendSelection(range, text);
}

function onReverseTriggerClick(): void {
  if (!isExtensionAlive()) {
    cleanup();
    return;
  }
  const text = currentSelection;
  if (!text || !selRect) return;

  const rect = selRect;

  removeTrigger();

  const sourceLang = detectLanguage(text);
  const targetLang = lastDetectedSourceLang;

  // If reverse target equals detected source, fall back to saved targetLang
  if (!targetLang || targetLang === sourceLang) {
    translateWithSavedTarget(text, rect, sourceLang);
    return;
  }

  createPopup(rect, sourceLang, targetLang);
  translate(text, sourceLang, targetLang);
}

// --- Selection Listener ---
document.addEventListener('mouseup', (e) => {
  const target = e.target as Element;
  if (target === triggerBtn) return;
  if (popupHost && (popupHost === target || popupHost.contains(target))) return;
  if (target.closest?.('#ai-translator-popup-host')) return;
  if (target.closest?.('.ai-translator-trigger')) return;
  if (target.closest?.('.ai-translator-trigger-container')) return;

  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();

    // Form controls expose their selection separately from window.getSelection()
    const ae = document.activeElement;
    if (
      (!text || text.length < 2) &&
      isTextInput(ae) &&
      ae.selectionStart != null &&
      ae.selectionEnd != null &&
      ae.selectionEnd > ae.selectionStart
    ) {
      const sub = ae.value.slice(ae.selectionStart, ae.selectionEnd).trim();
      if (sub.length >= 2) {
        currentSelection = sub;
        selFormControl = ae;
        selStart = ae.selectionStart;
        selEnd = ae.selectionEnd;
        selRange = null;
        selAnchorEl = ae;
        selRect = ae.getBoundingClientRect();
        showTrigger(selRect, ae);
        return;
      }
    }

    if (!sel || !text || text.length < 2) {
      removeTrigger();
      return;
    }

    currentSelection = text;
    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      selFormControl = null;
      selRange = range.cloneRange();
      selRect = rect;
      selAnchorEl =
        sel.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? (sel.anchorNode as Element)
          : (sel.anchorNode?.parentElement ?? null);
      showTrigger(rect, selAnchorEl);
    } catch {
      // selection lost
    }
  }, 50);
});

// --- Commands from the toolbar popup (Translate This Page / Revert) ---
// Top frame only (the popup targets frameId 0): iframes never translate the page.
if (window === window.top) {
  onTargetMessage<TranslatorPageRequest>(TRANSLATOR_PAGE_TARGET, (request): Result | PageStateResponse => {
    switch (request.type) {
      case 'translate-page':
        void translatePage();
        return { ok: true };
      case 'revert-page':
        revertPageTranslation();
        return { ok: true };
      case 'get-state':
        return { ok: true, state: getPageTranslationState() };
    }
  });
}
