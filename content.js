(() => {
  let triggerBtn = null;
  let popupHost = null;
  let shadowRoot = null;
  let currentSelection = "";
  let lastDetectedSourceLang = null;

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
  function detectLanguage(text) {
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return "japanese";
    if (/[\u4E00-\u9FFF]/.test(text) && !/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return "chinese";
    if (/[\uAC00-\uD7AF]/.test(text)) return "korean";
    if (/[\u0E00-\u0E7F]/.test(text)) return "thai";
    if (/[\u0900-\u097F]/.test(text)) return "hindi";
    if (/[\u0600-\u06FF]/.test(text)) return "arabic";
    if (/[\u0400-\u04FF]/.test(text)) return "russian";
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

  // --- Trigger Button ---
  function showTrigger(rect, anchorEl) {
    removeTrigger();

    const container = document.createElement("div");
    container.className = "ai-translator-trigger-container";

    // Always create the translate button
    const tBtn = document.createElement("button");
    tBtn.className = "ai-translator-trigger ai-translator-trigger-translate";
    tBtn.textContent = "T";
    tBtn.title = "Translate";
    tBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    tBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onTriggerClick(); });
    container.appendChild(tBtn);

    // Show reverse button if editable + has previous source lang
    const showReverse = isEditableElement(anchorEl) && lastDetectedSourceLang !== null;
    if (showReverse) {
      const rBtn = document.createElement("button");
      rBtn.className = "ai-translator-trigger ai-translator-trigger-reverse";
      rBtn.textContent = "R";
      rBtn.title = "Reverse Translate";
      rBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      rBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onReverseTriggerClick(); });
      container.appendChild(rBtn);
    } else {
      container.classList.add("single");
    }

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const btnSize = 34;
    const totalWidth = showReverse ? btnSize * 2 : btnSize;
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
  function createPopup(rect, sourceLang, targetLang) {
    if (!isExtensionValid()) { cleanup(); return; }
    removePopup();

    popupHost = document.createElement("div");
    popupHost.id = "ai-translator-popup-host";
    popupHost.style.cssText = "position:absolute;z-index:2147483647;";

    shadowRoot = popupHost.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <style>${getPopupCSS()}</style>
      <div class="popup">
        <div class="resize-handle resize-left"></div>
        <div class="resize-handle resize-right"></div>
        <div class="header">
          <div class="lang-pair">
            <span class="lang-badge source">${LANGUAGES[sourceLang]?.label || "?"}</span>
            <span class="arrow">\u2192</span>
            <select class="lang-select" id="targetSelect">${buildLangOptions(targetLang)}</select>
          </div>
          <button class="close-btn" id="closeBtn">\u2715</button>
        </div>
        <div class="result" id="result">
          <div class="loading"><span class="spinner"></span> Translating...</div>
        </div>
        <div class="footer">
          <button class="copy-btn" id="copyBtn" disabled>Copy</button>
          <select class="style-select" id="styleSelect">
            <option value="casual">Casual</option>
            <option value="polite">Polite</option>
            <option value="business">Business</option>
          </select>
        </div>
      </div>
    `;

    // Apply saved width
    const popup = shadowRoot.querySelector(".popup");
    chrome.storage.sync.get({ popupWidth: 340 }, (data) => {
      popup.style.setProperty("--popup-width", `${data.popupWidth}px`);
    });

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

    // Load saved style
    chrome.storage.sync.get({ style: "casual" }, (data) => {
      const select = shadowRoot.getElementById("styleSelect");
      if (select) select.value = data.style;
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

    // Resize handles
    setupResizeHandle(shadowRoot.querySelector(".resize-right"), "right");
    setupResizeHandle(shadowRoot.querySelector(".resize-left"), "left");

    // Drag handle (header)
    setupDragHandle(shadowRoot.querySelector(".header"));
  }

  function setupResizeHandle(handle, side) {
    const minWidth = 240;
    const maxWidth = 600;

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const popup = shadowRoot.querySelector(".popup");
      const startX = e.clientX;
      const startWidth = popup.offsetWidth;
      const startLeft = popupHost.offsetLeft;

      function onMouseMove(e) {
        let delta = e.clientX - startX;
        let newWidth;

        if (side === "right") {
          newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
        } else {
          newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth - delta));
          popupHost.style.left = `${startLeft + (startWidth - newWidth)}px`;
        }

        popup.style.setProperty("--popup-width", `${newWidth}px`);
      }

      function onMouseUp() {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        // Save width preference
        const finalWidth = popup.offsetWidth;
        chrome.storage.sync.set({ popupWidth: finalWidth });
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

  function onTriggerClick() {
    if (!isExtensionValid()) { cleanup(); return; }
    const text = currentSelection;
    if (!text) return;

    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();

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

  function onReverseTriggerClick() {
    if (!isExtensionValid()) { cleanup(); return; }
    const text = currentSelection;
    if (!text) return;

    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();

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
      const text = sel?.toString().trim();

      if (!text || text.length < 2) {
        removeTrigger();
        return;
      }

      currentSelection = text;
      try {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const anchorEl = sel.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? sel.anchorNode
          : sel.anchorNode?.parentElement;
        showTrigger(rect, anchorEl);
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
      chrome.storage.sync.get({ apiKey: "", targetLang: "vietnamese", style: "casual", provider: "openai" }, r)
    );
    if (settings.provider !== "ollama" && !settings.apiKey) {
      showLoadingError("No API key set. Open extension settings.");
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
        top: 0;
        bottom: 0;
        width: 6px;
        cursor: col-resize;
        z-index: 10;
      }

      .resize-right {
        right: -3px;
      }

      .resize-left {
        left: -3px;
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
