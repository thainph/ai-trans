(() => {
  let triggerBtn = null;
  let popupHost = null;
  let shadowRoot = null;
  let currentSelection = "";
  let lastDetectedSourceLang = null;

  // --- Selection context ---
  // Captured at mouseup because opening the popup / clicking a button collapses
  // the live selection. Form controls (input/textarea) expose their selection
  // through selectionStart/End, NOT window.getSelection(), so they need a
  // separate path from normal/contenteditable selections.
  let selFormControl = null;  // INPUT/TEXTAREA element, or null
  let selStart = 0, selEnd = 0;
  let selRange = null;        // cloned Range (normal / contenteditable)
  let selRect = null;         // rect used to anchor trigger + popup
  let selAnchorEl = null;     // nearest element (editability check)

  // --- Grammar replace target (snapshot taken when G is clicked) ---
  let grammarFormControl = null;  // INPUT/TEXTAREA to write back into
  let grammarEditable = null;     // contenteditable node to write back into
  let grammarRange = null;        // cloned Range (contenteditable)
  let grammarStart = 0, grammarEnd = 0;

  // --- Full Page Translation State ---
  let pageTranslationState = "idle"; // "idle" | "translating" | "translated"
  const originalTexts = new Map();
  let translationCancelled = false;
  let loadingHost = null;
  let loadingShadow = null;
  let domObserver = null;
  let pendingNewNodes = [];
  let pendingTimer = null;
  let lastTranslationLangs = null; // { sourceLang, targetLang, style }

  function isExtensionValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function cleanup() {
    removeTrigger();
    removePopup();
  }

  // --- Supported Languages ---
  const LANGUAGES = {
    english:    { label: "EN",  name: "English" },
    japanese:   { label: "JP",  name: "Japanese" },
    vietnamese: { label: "VI",  name: "Vietnamese" },
    chinese:    { label: "ZH",  name: "Chinese" },
    korean:     { label: "KO",  name: "Korean" },
    french:     { label: "FR",  name: "French" },
    german:     { label: "DE",  name: "German" },
    spanish:    { label: "ES",  name: "Spanish" },
    portuguese: { label: "PT",  name: "Portuguese" },
    russian:    { label: "RU",  name: "Russian" },
    thai:       { label: "TH",  name: "Thai" },
    indonesian: { label: "ID",  name: "Indonesian" },
    italian:    { label: "IT",  name: "Italian" },
    dutch:      { label: "NL",  name: "Dutch" },
    arabic:     { label: "AR",  name: "Arabic" },
    hindi:      { label: "HI",  name: "Hindi" },
  };

  // --- Language Detection ---
  // Picks the script with the most characters instead of the first one that
  // appears at all: a single "・" bullet or "ー" in a Vietnamese/English text
  // used to make the whole selection "Japanese", and the model then skipped
  // the parts that were not Japanese.
  function detectLanguage(text) {
    const count = (re) => (text.match(re) || []).length;
    // U+30FB "・" and U+30FC "ー" are also used as plain symbols → not counted as kana.
    const kana = count(/[\u3040-\u309F\u30A0-\u30FA\u30FD-\u30FF]/g);
    const han = count(/[\u4E00-\u9FFF]/g);
    // One CJK/Hangul character carries roughly as much text as ~3 Latin letters.
    const CJK_WEIGHT = 3;
    const scores = {
      japanese: kana > 0 ? (kana + han) * CJK_WEIGHT : 0,
      chinese: kana > 0 ? 0 : han * CJK_WEIGHT,
      korean: count(/[\uAC00-\uD7AF]/g) * CJK_WEIGHT,
      thai: count(/[\u0E00-\u0E7F]/g),
      hindi: count(/[\u0900-\u097F]/g),
      arabic: count(/[\u0600-\u06FF]/g),
      russian: count(/[\u0400-\u04FF]/g),
      latin: count(/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/g),
    };
    let best = "latin";
    for (const [lang, score] of Object.entries(scores)) {
      if (score > scores[best]) best = lang;
    }
    if (best !== "latin") return best;

    if (/[ạảầấậẩẫăằắặẳẵẹẻềếệểễịỉĩọỏồốộổỗơờớợởỡụủưừứựửữỵỷỹđ]/i.test(text)) return "vietnamese";
    if (/[æœïÿ]/i.test(text)) return "french";
    if (/[äöüß]/i.test(text)) return "german";
    if (/[ñ¿¡]/i.test(text)) return "spanish";
    if (/[ãõ]/i.test(text) && !/[ạảậẩẫăằắặẳẵẹẻệểễịỉĩọỏộổỗơờớợởỡụủưừứựửữỵỷỹđ]/i.test(text)) return "portuguese";
    return "english";
  }

  // --- Helper: check if element is editable ---
  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  // Text-like form controls whose selection we can read/write (skip password, etc.)
  function isTextInput(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return ["text", "search", "url", "email", "tel"].includes(t);
    }
    return false;
  }

  // --- Trigger Button ---
  function showTrigger(rect, anchorEl) {
    removeTrigger();

    const container = document.createElement("div");
    container.className = "ai-translator-trigger-container";

    const isEditable = isEditableElement(anchorEl);

    // Always create the translate button
    const tBtn = document.createElement("button");
    tBtn.className = "ai-translator-trigger ai-translator-trigger-translate";
    tBtn.textContent = "T";
    tBtn.title = "Translate";
    tBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    tBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onTriggerClick(); });
    container.appendChild(tBtn);

    // Grammar check — only in editable fields (correct the text you are writing)
    if (isEditable) {
      const gBtn = document.createElement("button");
      gBtn.className = "ai-translator-trigger ai-translator-trigger-grammar";
      gBtn.textContent = "G";
      gBtn.title = "Check English Grammar";
      gBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      gBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onGrammarClick(); });
      container.appendChild(gBtn);
    }

    // Send the selection to Devdy — page text only (not what you are typing).
    // window.__contextKitDevdy comes from page-content.js (same isolated world).
    if (!isEditable && window.__contextKitDevdy) {
      const dBtn = document.createElement("button");
      dBtn.className = "ai-translator-trigger ai-translator-trigger-devdy";
      dBtn.title = "Send selection to Devdy";
      dBtn.setAttribute("aria-label", "Send selection to Devdy");
      dBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
      dBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      dBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onDevdyClick(); });
      container.appendChild(dBtn);
    }

    // Show reverse button if editable + has previous source lang
    const showReverse = isEditable && lastDetectedSourceLang !== null;
    if (showReverse) {
      const rBtn = document.createElement("button");
      rBtn.className = "ai-translator-trigger ai-translator-trigger-reverse";
      rBtn.textContent = "R";
      rBtn.title = "Reverse Translate";
      rBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      rBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onReverseTriggerClick(); });
      container.appendChild(rBtn);
    }

    const btnCount = container.childElementCount;
    if (btnCount === 1) container.classList.add("single");

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

  function removeTrigger() {
    if (triggerBtn) {
      triggerBtn.remove();
      triggerBtn = null;
    }
  }

  // --- Build target language <option> list ---
  function buildLangOptions(selectedLang) {
    return Object.entries(LANGUAGES)
      .map(([key, { label, name }]) => {
        const sel = key === selectedLang ? " selected" : "";
        return `<option value="${key}"${sel}>${label} - ${name}</option>`;
      })
      .join("");
  }

  // --- Popup (Shadow DOM) ---
  function createPopup(rect, sourceLang, targetLang, mode = "translate") {
    if (!isExtensionValid()) { cleanup(); return; }
    removePopup();

    popupHost = document.createElement("div");
    popupHost.id = "ai-translator-popup-host";
    popupHost.style.cssText = "position:absolute;z-index:2147483647;";

    const isGrammar = mode === "grammar";
    const headerInner = isGrammar
      ? `<div class="lang-pair">
            <span class="lang-badge source">EN</span>
            <span class="grammar-label">Grammar</span>
          </div>`
      : `<div class="lang-pair">
            <span class="lang-badge source">${LANGUAGES[sourceLang]?.label || "?"}</span>
            <span class="arrow">\u2192</span>
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
    const loadingLabel = isGrammar ? "Checking..." : "Translating...";

    shadowRoot = popupHost.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <style>${getPopupCSS()}</style>
      <div class="popup">
        <div class="resize-handle resize-left"></div>
        <div class="resize-handle resize-right"></div>
        <div class="resize-handle resize-top"></div>
        <div class="resize-handle resize-bottom"></div>
        <div class="header">
          ${headerInner}
          <button class="close-btn" id="closeBtn">\u2715</button>
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
    const popup = shadowRoot.querySelector(".popup");

    // Position popup
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const popupWidth = 340;
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
    popup.style.setProperty("--popup-max-height", `${maxHeight}px`);

    // Apply saved width + height (clamp height to available space)
    chrome.storage.sync.get({ popupWidth: 340, popupHeight: 0 }, (data) => {
      popup.style.setProperty("--popup-width", `${data.popupWidth}px`);
      if (data.popupHeight > 0) {
        const clamped = Math.min(data.popupHeight, maxHeight);
        popup.style.setProperty("--popup-height", `${clamped}px`);
        popup.style.setProperty("--popup-max-height", `${clamped}px`);
      }
    });

    let top;
    if (showAbove) {
      top = rect.top + scrollY - maxHeight - gap;
      if (top < scrollY) top = scrollY + gap;
    } else {
      top = rect.bottom + scrollY + gap;
    }

    popupHost.style.left = `${left}px`;
    popupHost.style.top = `${top}px`;

    document.body.appendChild(popupHost);

    // Adjust position after render using actual height
    requestAnimationFrame(() => {
      if (!shadowRoot) return;
      const popupEl = shadowRoot.querySelector(".popup");
      if (!popupEl) return;
      const actualHeight = popupEl.offsetHeight;
      if (showAbove) {
        const adjustedTop = rect.top + scrollY - actualHeight - gap;
        popupHost.style.top = `${Math.max(adjustedTop, scrollY + gap)}px`;
      }
    });

    // Event listeners
    shadowRoot.getElementById("closeBtn").addEventListener("click", removePopup);

    shadowRoot.getElementById("copyBtn").addEventListener("click", () => {
      const resultEl = shadowRoot.getElementById("result");
      const text = resultEl.textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = shadowRoot.getElementById("copyBtn");
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy"), 1500);
      });
    });

    if (isGrammar) {
      // Replace → write the corrected text back into the editable field
      shadowRoot.getElementById("replaceBtn").addEventListener("click", () => {
        const resultEl = shadowRoot.getElementById("result");
        applyGrammarReplace(resultEl.textContent);
      });
    } else {
      // Load saved style
      chrome.storage.sync.get({ style: "casual" }, (data) => {
        const select = shadowRoot.getElementById("styleSelect");
        if (select) select.value = data.style;
      });

      // Target language change → re-translate
      shadowRoot.getElementById("targetSelect").addEventListener("change", (e) => {
        chrome.storage.sync.set({ targetLang: e.target.value });
        translate(currentSelection, sourceLang, e.target.value);
      });

      // Style change → re-translate
      shadowRoot.getElementById("styleSelect").addEventListener("change", (e) => {
        chrome.storage.sync.set({ style: e.target.value });
        const targetSel = shadowRoot.getElementById("targetSelect");
        translate(currentSelection, sourceLang, targetSel.value);
      });
    }

    // Resize handles
    setupResizeHandle(shadowRoot.querySelector(".resize-right"), "right");
    setupResizeHandle(shadowRoot.querySelector(".resize-left"), "left");
    setupResizeHandle(shadowRoot.querySelector(".resize-top"), "top");
    setupResizeHandle(shadowRoot.querySelector(".resize-bottom"), "bottom");

    // Drag handle (header)
    setupDragHandle(shadowRoot.querySelector(".header"));
  }

  function setupResizeHandle(handle, side) {
    const minWidth = 240;
    const maxWidth = 600;
    const minHeight = 120;
    const isVertical = side === "top" || side === "bottom";

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const popup = shadowRoot.querySelector(".popup");
      const startX = e.clientX;
      const startY = e.clientY;
      const startWidth = popup.offsetWidth;
      const startHeight = popup.offsetHeight;
      const startLeft = popupHost.offsetLeft;
      const startTop = popupHost.offsetTop;
      const maxHeight = Math.max(window.innerHeight - 40, minHeight);

      function onMouseMove(e) {
        if (isVertical) {
          const delta = e.clientY - startY;
          let newHeight;
          if (side === "bottom") {
            newHeight = Math.min(maxHeight, Math.max(minHeight, startHeight + delta));
          } else {
            newHeight = Math.min(maxHeight, Math.max(minHeight, startHeight - delta));
            popupHost.style.top = `${startTop + (startHeight - newHeight)}px`;
          }
          popup.style.setProperty("--popup-height", `${newHeight}px`);
          popup.style.setProperty("--popup-max-height", `${newHeight}px`);
        } else {
          const delta = e.clientX - startX;
          let newWidth;
          if (side === "right") {
            newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
          } else {
            newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth - delta));
            popupHost.style.left = `${startLeft + (startWidth - newWidth)}px`;
          }
          popup.style.setProperty("--popup-width", `${newWidth}px`);
        }
      }

      function onMouseUp() {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        if (isVertical) {
          chrome.storage.sync.set({ popupHeight: popup.offsetHeight });
        } else {
          chrome.storage.sync.set({ popupWidth: popup.offsetWidth });
        }
      }

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  function setupDragHandle(header) {
    header.addEventListener("mousedown", (e) => {
      // Don't drag when clicking on buttons or selects
      if (e.target.closest("button, select")) return;
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = popupHost.offsetLeft;
      const startTop = popupHost.offsetTop;

      header.style.cursor = "grabbing";

      function onMouseMove(e) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        popupHost.style.left = `${startLeft + dx}px`;
        popupHost.style.top = `${startTop + dy}px`;
      }

      function onMouseUp() {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        header.style.cursor = "";
      }

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  function removePopup() {
    if (popupHost) {
      popupHost.remove();
      popupHost = null;
      shadowRoot = null;
    }
  }

  function showResult(text) {
    if (!shadowRoot) return;
    const resultEl = shadowRoot.getElementById("result");
    resultEl.textContent = text;
    const copyBtn = shadowRoot.getElementById("copyBtn");
    copyBtn.disabled = false;
    const replaceBtn = shadowRoot.getElementById("replaceBtn");
    if (replaceBtn) replaceBtn.disabled = false;
  }

  function showError(msg) {
    if (!shadowRoot) return;
    const resultEl = shadowRoot.getElementById("result");
    resultEl.innerHTML = `<div class="error">${escapeHtml(msg)}</div>`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Translation ---
  function translate(text, sourceLang, targetLang) {
    if (!shadowRoot) return;
    if (!isExtensionValid()) { cleanup(); return; }
    const resultEl = shadowRoot.getElementById("result");
    resultEl.innerHTML = `<div class="loading"><span class="spinner"></span> Translating...</div>`;
    const copyBtn = shadowRoot.getElementById("copyBtn");
    copyBtn.disabled = true;

    chrome.storage.sync.get({ style: "casual" }, (data) => {
      const style = data.style;
      chrome.runtime.sendMessage(
        { action: "translate", text, sourceLang, targetLang, style },
        (response) => {
          if (chrome.runtime.lastError) {
            showError(chrome.runtime.lastError.message);
            return;
          }
          if (response && response.success) {
            showResult(response.translation);
          } else {
            showError(response?.error || "Translation failed");
          }
        }
      );
    });
  }

  // --- Grammar Check ---
  function checkGrammar(text) {
    if (!shadowRoot) return;
    if (!isExtensionValid()) { cleanup(); return; }
    const resultEl = shadowRoot.getElementById("result");
    resultEl.innerHTML = `<div class="loading"><span class="spinner"></span> Checking...</div>`;
    const copyBtn = shadowRoot.getElementById("copyBtn");
    if (copyBtn) copyBtn.disabled = true;
    const replaceBtn = shadowRoot.getElementById("replaceBtn");
    if (replaceBtn) replaceBtn.disabled = true;

    chrome.runtime.sendMessage({ action: "grammarCheck", text }, (response) => {
      if (chrome.runtime.lastError) {
        showError(chrome.runtime.lastError.message);
        return;
      }
      if (response && response.success) {
        showResult(response.corrected);
      } else {
        showError(response?.error || "Grammar check failed");
      }
    });
  }

  function onGrammarClick() {
    if (!isExtensionValid()) { cleanup(); return; }
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

    createPopup(selRect, "english", "english", "grammar");
    checkGrammar(text);
  }

  // Set a form control's value via the native setter so React (and similar
  // controlled components) register the change instead of overwriting it.
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function applyGrammarReplace(corrected) {
    try {
      if (grammarFormControl) {
        const fc = grammarFormControl;
        fc.focus();
        const value = fc.value;
        setNativeValue(fc, value.slice(0, grammarStart) + corrected + value.slice(grammarEnd));
        const caret = grammarStart + corrected.length;
        fc.setSelectionRange(caret, caret);
        fc.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (grammarEditable) {
        // Focus the contenteditable host, not a child node (spans aren't focusable)
        const host = grammarEditable.closest?.("[contenteditable]") || grammarEditable;
        host.focus?.();
        if (grammarRange) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(grammarRange);
        }
        // execCommand triggers proper input events for framework-managed editors
        const ok = document.execCommand("insertText", false, corrected);
        if (!ok && grammarRange) {
          grammarRange.deleteContents();
          grammarRange.insertNode(document.createTextNode(corrected));
          host.dispatchEvent?.(new Event("input", { bubbles: true }));
        }
      } else {
        removePopup();
        return;
      }
    } catch (err) {
      console.warn("AI Translator: grammar replace failed", err.message);
    }

    grammarFormControl = null;
    grammarEditable = null;
    grammarRange = null;
    removePopup();
  }

  function onTriggerClick() {
    if (!isExtensionValid()) { cleanup(); return; }
    const text = currentSelection;
    if (!text || !selRect) return;

    const rect = selRect;

    removeTrigger();

    const sourceLang = detectLanguage(text);
    lastDetectedSourceLang = sourceLang;

    // Use saved target language, fallback to vietnamese
    chrome.storage.sync.get({ targetLang: "vietnamese" }, (data) => {
      let targetLang = data.targetLang;
      // If source and target are the same, switch to english
      if (targetLang === sourceLang) {
        targetLang = sourceLang === "english" ? "vietnamese" : "english";
      }
      createPopup(rect, sourceLang, targetLang);
      translate(text, sourceLang, targetLang);
    });
  }

  function onDevdyClick() {
    if (!isExtensionValid()) { cleanup(); return; }
    const text = currentSelection;
    const range = selRange;
    if (!text || !range || !window.__contextKitDevdy) return;
    removeTrigger();
    window.__contextKitDevdy.sendSelection(range, text);
  }

  function onReverseTriggerClick() {
    if (!isExtensionValid()) { cleanup(); return; }
    const text = currentSelection;
    if (!text || !selRect) return;

    const rect = selRect;

    removeTrigger();

    const sourceLang = detectLanguage(text);
    let targetLang = lastDetectedSourceLang;

    // If reverse target equals detected source, fall back to saved targetLang
    if (targetLang === sourceLang) {
      chrome.storage.sync.get({ targetLang: "vietnamese" }, (data) => {
        let fallback = data.targetLang;
        if (fallback === sourceLang) {
          fallback = sourceLang === "english" ? "vietnamese" : "english";
        }
        createPopup(rect, sourceLang, fallback);
        translate(text, sourceLang, fallback);
      });
      return;
    }

    createPopup(rect, sourceLang, targetLang);
    translate(text, sourceLang, targetLang);
  }

  // --- Selection Listener ---
  document.addEventListener("mouseup", (e) => {
    const target = e.target;
    if (target === triggerBtn) return;
    if (popupHost && (popupHost === target || popupHost.contains(target))) return;
    if (target.closest?.("#ai-translator-popup-host")) return;
    if (target.closest?.(".ai-translator-trigger")) return;
    if (target.closest?.(".ai-translator-trigger-container")) return;

    setTimeout(() => {
      const sel = window.getSelection();
      let text = sel?.toString().trim();

      // Form controls expose their selection separately from window.getSelection()
      const ae = document.activeElement;
      if ((!text || text.length < 2) && isTextInput(ae) &&
          ae.selectionStart != null && ae.selectionEnd > ae.selectionStart) {
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

      if (!text || text.length < 2) {
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
        selAnchorEl = sel.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? sel.anchorNode
          : sel.anchorNode?.parentElement;
        showTrigger(rect, selAnchorEl);
      } catch (err) {
        // selection lost
      }
    }, 50);
  });

  // --- Full Page Translation ---
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS",
    "TEXTAREA", "INPUT", "SELECT", "CODE", "PRE", "KBD", "SAMP",
  ]);

  function collectTranslatableTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (parent.closest("#ai-translator-popup-host, #ai-translator-loading-host, .ai-translator-trigger-container")) {
          return NodeFilter.FILTER_REJECT;
        }
        const text = node.textContent.trim();
        if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
        if (!needsTranslation(text)) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    return nodes;
  }

  // Skip text that doesn't need translation
  function needsTranslation(text) {
    if (/^\d[\d\s.,:%/\-+()]*$/.test(text)) return false;  // numbers only
    if (/^https?:\/\/\S+$/.test(text)) return false;        // URLs
    if (/^[^a-zA-Z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]+$/.test(text)) return false; // no letters at all
    return true;
  }

  function createBatches(textNodes, maxChars = 3000) {
    const batches = [];
    let current = [];
    let currentLen = 0;
    for (const node of textNodes) {
      const text = node.textContent.trim();
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

  async function translatePage() {
    if (!isExtensionValid()) return;
    if (pageTranslationState === "translating") return;

    const settings = await new Promise((r) =>
      chrome.storage.sync.get({ apiKey: "", geminiApiKey: "", targetLang: "vietnamese", style: "casual", provider: "openai" }, r)
    );
    if (settings.provider === "openai" && !settings.apiKey) {
      showLoadingError("No API key set. Open extension settings.");
      return;
    }
    if (settings.provider === "gemini" && !settings.geminiApiKey) {
      showLoadingError("No Gemini API key set. Open extension settings.");
      return;
    }

    pageTranslationState = "translating";
    translationCancelled = false;
    originalTexts.clear();
    showLoading();

    const textNodes = collectTranslatableTextNodes();
    if (textNodes.length === 0) {
      pageTranslationState = "idle";
      hideLoading();
      return;
    }

    const batches = createBatches(textNodes);
    const totalBatches = batches.length;

    // Detect source language from page sample
    const sampleText = textNodes.slice(0, 10).map((n) => n.textContent).join(" ");
    let sourceLang = detectLanguage(sampleText);
    let targetLang = settings.targetLang;
    if (targetLang === sourceLang) {
      targetLang = sourceLang === "english" ? "vietnamese" : "english";
    }

    const CONCURRENCY = settings.provider === "ollama" ? 2 : 5;
    let completed = 0;
    let failed = false;

    function translateBatch(batch) {
      return new Promise((resolve, reject) => {
        const texts = batch.map((n) => n.textContent.trim());
        chrome.runtime.sendMessage(
          { action: "translateBatch", texts, sourceLang, targetLang, style: settings.style },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response && response.success) {
              resolve(response.translations);
            } else {
              reject(new Error(response?.error || "Translation failed"));
            }
          }
        );
      });
    }

    function applyBatchResult(batch, result) {
      for (let j = 0; j < batch.length; j++) {
        const node = batch[j];
        if (!originalTexts.has(node)) {
          originalTexts.set(node, node.textContent);
        }
        if (result[j]) {
          node.textContent = result[j];
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
        results.forEach((result, idx) => applyBatchResult(chunk[idx], result));
        completed += chunk.length;
        showLoading(`Translating... ${completed}/${totalBatches}`);
      } catch (err) {
        console.warn("AI Translator: batch failed", err.message);
        showLoadingError(`Error: ${err.message}`);
        pageTranslationState = originalTexts.size > 0 ? "translated" : "idle";
        failed = true;
      }
    }

    if (failed) return;

    hideLoading();

    if (translationCancelled) {
      pageTranslationState = originalTexts.size > 0 ? "translated" : "idle";
    } else {
      pageTranslationState = "translated";
    }

    if (pageTranslationState === "translated") {
      lastTranslationLangs = { sourceLang, targetLang, style: settings.style };
      startDomObserver();
    }
  }

  function revertPageTranslation() {
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
    pageTranslationState = "idle";
  }

  function cancelPageTranslation() {
    translationCancelled = true;
  }

  // --- MutationObserver for dynamic content ---
  function isTranslatableTextNode(node) {
    const parent = node.parentElement;
    if (!parent) return false;
    if (SKIP_TAGS.has(parent.tagName)) return false;
    if (parent.isContentEditable) return false;
    if (parent.closest("#ai-translator-popup-host, #ai-translator-loading-host, .ai-translator-trigger-container")) return false;
    const text = node.textContent.trim();
    if (text.length < 2) return false;
    if (!needsTranslation(text)) return false;
    if (originalTexts.has(node)) return false;
    return true;
  }

  function collectNewTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isTranslatableTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function startDomObserver() {
    if (domObserver) return;
    domObserver = new MutationObserver((mutations) => {
      if (pageTranslationState !== "translated") return;

      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) {
            if (isTranslatableTextNode(added)) pendingNewNodes.push(added);
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

  function stopDomObserver() {
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
    pendingNewNodes = [];
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  async function flushPendingNodes() {
    pendingTimer = null;
    const nodes = pendingNewNodes.filter((n) => n.isConnected && !originalTexts.has(n) && n.textContent.trim().length >= 2);
    pendingNewNodes = [];
    if (nodes.length === 0 || !lastTranslationLangs || !isExtensionValid()) return;

    const { sourceLang, targetLang, style } = lastTranslationLangs;
    const batches = createBatches(nodes);

    for (const batch of batches) {
      const texts = batch.map((n) => n.textContent.trim());
      try {
        const result = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { action: "translateBatch", texts, sourceLang, targetLang, style },
            (response) => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              if (response?.success) resolve(response.translations);
              else reject(new Error(response?.error || "Translation failed"));
            }
          );
        });
        for (let j = 0; j < batch.length; j++) {
          if (!originalTexts.has(batch[j])) originalTexts.set(batch[j], batch[j].textContent);
          if (result[j]) batch[j].textContent = result[j];
        }
      } catch (err) {
        console.warn("AI Translator: dynamic translate failed", err.message);
      }
    }
  }

  // --- Loading Indicator ---
  function showLoading(progress) {
    if (!loadingHost) {
      loadingHost = document.createElement("div");
      loadingHost.id = "ai-translator-loading-host";
      loadingShadow = loadingHost.attachShadow({ mode: "open" });
      loadingShadow.innerHTML = `
        <style>
          .loading-bar {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 2147483647;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 14px;
            background: #1e293b;
            color: #e2e8f0;
            border-radius: 20px;
            font-family: system-ui, -apple-system, sans-serif;
            font-size: 13px;
            font-weight: 500;
            box-shadow: 0 4px 16px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.08);
            animation: fade-in 0.2s ease-out;
          }
          .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255,255,255,0.2);
            border-top-color: #60a5fa;
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
          }
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        </style>
        <div class="loading-bar">
          <div class="spinner"></div>
          <span id="loadingText">Translating...</span>
        </div>
      `;
      document.body.appendChild(loadingHost);
    }
    const text = loadingShadow.getElementById("loadingText");
    if (text) text.textContent = progress || "Translating...";
  }

  function hideLoading() {
    if (loadingHost) {
      loadingHost.remove();
      loadingHost = null;
      loadingShadow = null;
    }
  }

  function showLoadingError(msg) {
    if (!loadingHost) {
      showLoading();
    }
    const bar = loadingShadow.querySelector(".loading-bar");
    const spinner = loadingShadow.querySelector(".spinner");
    const text = loadingShadow.getElementById("loadingText");
    if (bar) bar.style.background = "#7f1d1d";
    if (spinner) spinner.style.display = "none";
    if (text) text.textContent = msg;
    setTimeout(hideLoading, 5000);
  }

  // --- Message Listener (from popup.js) ---
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "translatePage") {
      translatePage();
      sendResponse({ ok: true });
    } else if (request.action === "revertPage") {
      revertPageTranslation();
      sendResponse({ ok: true });
    } else if (request.action === "getPageTranslationState") {
      sendResponse({ state: pageTranslationState });
    }
  });

  // --- Popup CSS ---
  function getPopupCSS() {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }

      .popup {
        width: var(--popup-width, 340px);
        height: var(--popup-height, auto);
        max-height: var(--popup-max-height, 70vh);
        display: flex;
        flex-direction: column;
        position: relative;
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        color: #1a1a1a;
        overflow: hidden;
      }

      .resize-handle {
        position: absolute;
        z-index: 10;
      }

      .resize-right, .resize-left {
        top: 0;
        bottom: 0;
        width: 6px;
        cursor: col-resize;
      }

      .resize-right {
        right: -3px;
      }

      .resize-left {
        left: -3px;
      }

      .resize-top, .resize-bottom {
        left: 6px;
        right: 6px;
        height: 6px;
        cursor: row-resize;
      }

      .resize-top {
        top: -3px;
      }

      .resize-bottom {
        bottom: -3px;
      }

      .resize-handle:hover {
        background: rgba(37, 99, 235, 0.15);
        border-radius: 3px;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: #f8fafc;
        border-bottom: 1px solid #e5e7eb;
        flex-shrink: 0;
        cursor: grab;
        user-select: none;
      }

      .header:active {
        cursor: grabbing;
      }

      .lang-pair {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .lang-badge {
        padding: 3px 10px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        border: none;
        cursor: default;
      }

      .lang-badge.source {
        background: #dbeafe;
        color: #1e40af;
      }

      .arrow {
        color: #9ca3af;
        font-size: 14px;
      }

      .grammar-label {
        font-size: 12px;
        font-weight: 600;
        color: #15803d;
      }

      .lang-select {
        padding: 3px 6px;
        border: 1px solid #d1d5db;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        background: #dcfce7;
        color: #166534;
        cursor: pointer;
        outline: none;
      }

      .lang-select:focus {
        border-color: #2563eb;
      }

      .close-btn {
        background: none;
        border: none;
        font-size: 16px;
        color: #9ca3af;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
      }

      .close-btn:hover {
        background: #f3f4f6;
        color: #374151;
      }

      .result {
        padding: 14px;
        min-height: 50px;
        flex: 1 1 auto;
        overflow-y: auto;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .loading {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #6b7280;
      }

      .spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid #e5e7eb;
        border-top-color: #2563eb;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .error {
        color: #dc2626;
        font-size: 13px;
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 14px;
        border-top: 1px solid #e5e7eb;
        background: #f8fafc;
        flex-shrink: 0;
      }

      .copy-btn {
        padding: 5px 14px;
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 5px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
      }

      .copy-btn:hover:not(:disabled) {
        background: #1d4ed8;
      }

      .copy-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .replace-btn {
        padding: 5px 14px;
        background: #16a34a;
        color: white;
        border: none;
        border-radius: 5px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
      }

      .replace-btn:hover:not(:disabled) {
        background: #15803d;
      }

      .replace-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .style-select {
        padding: 5px 8px;
        border: 1px solid #d1d5db;
        border-radius: 5px;
        font-size: 12px;
        background: white;
        color: #374151;
        cursor: pointer;
        outline: none;
      }

      .style-select:focus {
        border-color: #2563eb;
      }
    `;
  }
})();
