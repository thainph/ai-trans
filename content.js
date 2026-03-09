(() => {
  let triggerBtn = null;
  let popupHost = null;
  let shadowRoot = null;
  let currentSelection = "";

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
    if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text)) return "vietnamese";
    if (/[àâæçéèêëïîôœùûüÿ]/i.test(text)) return "french";
    if (/[äöüß]/i.test(text)) return "german";
    if (/[ñ¿¡áéíóúü]/i.test(text)) return "spanish";
    if (/[ãõçáéíóú]/i.test(text)) return "portuguese";
    return "english";
  }

  // --- Trigger Button ---
  function showTrigger(rect) {
    removeTrigger();
    triggerBtn = document.createElement("button");
    triggerBtn.className = "ai-translator-trigger";
    triggerBtn.textContent = "T";
    triggerBtn.title = "Translate";

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    triggerBtn.style.left = `${rect.left + scrollX + rect.width / 2 - 16}px`;
    triggerBtn.style.top = `${rect.bottom + scrollY + 6}px`;

    triggerBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    triggerBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onTriggerClick();
    });

    document.body.appendChild(triggerBtn);
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
    removePopup();

    popupHost = document.createElement("div");
    popupHost.id = "ai-translator-popup-host";
    popupHost.style.cssText = "position:absolute;z-index:2147483647;";

    shadowRoot = popupHost.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <style>${getPopupCSS()}</style>
      <div class="popup">
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

    // Position popup
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    let top = rect.bottom + scrollY + 10;
    let left = rect.left + scrollX;

    const popupWidth = 340;
    if (left + popupWidth > window.innerWidth + scrollX) {
      left = window.innerWidth + scrollX - popupWidth - 10;
    }
    if (left < scrollX) left = scrollX + 10;

    popupHost.style.left = `${left}px`;
    popupHost.style.top = `${top}px`;

    document.body.appendChild(popupHost);

    // Load saved style
    chrome.storage.sync.get(["style"], (data) => {
      const select = shadowRoot.getElementById("styleSelect");
      if (data.style && select) select.value = data.style;
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
    const resultEl = shadowRoot.getElementById("result");
    resultEl.innerHTML = `<div class="loading"><span class="spinner"></span> Translating...</div>`;
    const copyBtn = shadowRoot.getElementById("copyBtn");
    copyBtn.disabled = true;

    chrome.storage.sync.get(["style"], (data) => {
      const style = data.style || "casual";
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
    const text = currentSelection;
    if (!text) return;

    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();

    removeTrigger();

    const sourceLang = detectLanguage(text);

    // Use saved target language, fallback to vietnamese
    chrome.storage.sync.get(["targetLang"], (data) => {
      let targetLang = data.targetLang || "vietnamese";
      // If source and target are the same, switch to english
      if (targetLang === sourceLang) {
        targetLang = sourceLang === "english" ? "vietnamese" : "english";
      }
      createPopup(rect, sourceLang, targetLang);
      translate(text, sourceLang, targetLang);
    });
  }

  // --- Selection Listener ---
  document.addEventListener("mouseup", (e) => {
    const target = e.target;
    if (target === triggerBtn) return;
    if (popupHost && (popupHost === target || popupHost.contains(target))) return;
    if (target.closest?.("#ai-translator-popup-host")) return;
    if (target.closest?.(".ai-translator-trigger")) return;

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
        showTrigger(rect);
      } catch (err) {
        // selection lost
      }
    }, 50);
  });

  // Dismiss popup on click outside (but not trigger)
  document.addEventListener("mousedown", (e) => {
    const target = e.target;
    if (target === triggerBtn || triggerBtn?.contains(target)) return;
    if (target.closest?.(".ai-translator-trigger")) return;

    if (popupHost && popupHost !== target && !popupHost.contains(target) && !target.closest?.("#ai-translator-popup-host")) {
      removePopup();
    }
  });

  // --- Popup CSS ---
  function getPopupCSS() {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }

      .popup {
        width: 340px;
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        color: #1a1a1a;
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: #f8fafc;
        border-bottom: 1px solid #e5e7eb;
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
        max-height: 200px;
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
