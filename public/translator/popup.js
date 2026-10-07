const apiKeyInput = document.getElementById("apiKey");
const toggleKeyBtn = document.getElementById("toggleKey");
const statusEl = document.getElementById("status");
const targetLangSelect = document.getElementById("targetLang");
const translatePageBtn = document.getElementById("translatePage");
const translatePageLabel = document.getElementById("translatePageLabel");
const providerTabs = document.querySelectorAll(".provider-tab");
const openaiSettings = document.getElementById("openaiSettings");
const geminiSettings = document.getElementById("geminiSettings");
const ollamaSettings = document.getElementById("ollamaSettings");
const openaiModelSelect = document.getElementById("openaiModel");
const geminiApiKeyInput = document.getElementById("geminiApiKey");
const toggleGeminiKeyBtn = document.getElementById("toggleGeminiKey");
const geminiModelSelect = document.getElementById("geminiModel");
const ollamaUrlInput = document.getElementById("ollamaUrl");
const ollamaModelSelect = document.getElementById("ollamaModel");
const refreshOllamaBtn = document.getElementById("refreshOllama");
const saveSettingsBtn = document.getElementById("saveSettings");

// Currently selected provider tab (UI only — not persisted until Save)
let activeProvider = "openai";
// Ollama models are fetched from a server → load lazily, only when Ollama is active
let ollamaLoaded = false;
let savedOllamaModel = "";

// Load saved settings
chrome.storage.sync.get(
  {
    apiKey: "",
    style: "casual",
    targetLang: "vietnamese",
    provider: "openai",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "",
    openaiModel: "gpt-4o-mini",
    geminiApiKey: "",
    geminiModel: "gemini-2.5-flash",
  },
  (data) => {
    if (data.apiKey) apiKeyInput.value = data.apiKey;
    if (data.geminiApiKey) geminiApiKeyInput.value = data.geminiApiKey;
    const radio = document.querySelector(`input[name="style"][value="${data.style}"]`);
    if (radio) radio.checked = true;
    targetLangSelect.value = data.targetLang;
    openaiModelSelect.value = data.openaiModel;
    geminiModelSelect.value = data.geminiModel;
    // Saved model may be a since-removed/deprecated one → fall back to default
    if (!geminiModelSelect.value) geminiModelSelect.value = "gemini-2.5-flash";
    ollamaUrlInput.value = data.ollamaUrl;
    savedOllamaModel = data.ollamaModel;
    // switchProvider lazy-loads Ollama models only when Ollama is the active provider
    switchProvider(data.provider);
  }
);

// Provider tabs — switch the visible section only (no persistence)
function switchProvider(provider) {
  activeProvider = provider;
  providerTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });
  openaiSettings.classList.toggle("hidden", provider !== "openai");
  geminiSettings.classList.toggle("hidden", provider !== "gemini");
  ollamaSettings.classList.toggle("hidden", provider !== "ollama");

  // Fetch Ollama models only when its tab is active, and only once
  if (provider === "ollama" && !ollamaLoaded) {
    loadOllamaModels(ollamaUrlInput.value.trim(), savedOllamaModel);
  }
}

providerTabs.forEach((tab) => {
  tab.addEventListener("click", () => switchProvider(tab.dataset.provider));
});

// Toggle API key visibility
toggleKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

toggleGeminiKeyBtn.addEventListener("click", () => {
  geminiApiKeyInput.type = geminiApiKeyInput.type === "password" ? "text" : "password";
});

// Ollama: fetch models via background script (avoids CORS). UI only — never persists.
async function loadOllamaModels(url, selectedModel) {
  const base = url || ollamaUrlInput.value.trim() || "http://localhost:11434";
  ollamaLoaded = true; // avoid duplicate concurrent loads while pending
  ollamaModelSelect.innerHTML = `<option value="">Loading...</option>`;
  ollamaModelSelect.disabled = true;

  chrome.runtime.sendMessage({ action: "fetchOllamaModels", url: base }, (response) => {
    ollamaModelSelect.disabled = false;

    if (chrome.runtime.lastError || !response?.success) {
      ollamaLoaded = false; // allow retry on next tab switch / refresh
      ollamaModelSelect.innerHTML = `<option value="">Failed to load</option>`;
      showStatus(response?.error || "Cannot connect to Ollama", "error");
      return;
    }

    const models = response.models;
    if (models.length === 0) {
      ollamaModelSelect.innerHTML = `<option value="">No models found</option>`;
      return;
    }

    let options = `<option value="">-- Select model --</option>`;
    options += models
      .map((name) => `<option value="${name}"${name === selectedModel ? " selected" : ""}>${name}</option>`)
      .join("");
    ollamaModelSelect.innerHTML = options;

    // Preselect the saved model if still available, otherwise the first one (UI only)
    ollamaModelSelect.value = selectedModel && models.includes(selectedModel) ? selectedModel : models[0];
  });
}

refreshOllamaBtn.addEventListener("click", () => {
  loadOllamaModels(ollamaUrlInput.value.trim(), ollamaModelSelect.value);
});

// --- Unified Save: nothing persists until this is clicked ---
saveSettingsBtn.addEventListener("click", () => {
  // Validate the active provider's required credential
  if (activeProvider === "openai" && !apiKeyInput.value.trim()) {
    showStatus("Please enter your OpenAI API key", "error");
    return;
  }
  if (activeProvider === "gemini" && !geminiApiKeyInput.value.trim()) {
    showStatus("Please enter your Gemini API key", "error");
    return;
  }
  if (activeProvider === "ollama" && !ollamaModelSelect.value) {
    showStatus("Please select an Ollama model", "error");
    return;
  }

  const settings = {
    provider: activeProvider,
    apiKey: apiKeyInput.value.trim(),
    openaiModel: openaiModelSelect.value,
    geminiApiKey: geminiApiKeyInput.value.trim(),
    geminiModel: geminiModelSelect.value,
    ollamaUrl: ollamaUrlInput.value.trim() || "http://localhost:11434",
    ollamaModel: ollamaModelSelect.value,
    style: document.querySelector('input[name="style"]:checked')?.value || "casual",
    targetLang: targetLangSelect.value,
  };

  chrome.storage.sync.set(settings, () => {
    showStatus("Settings saved!", "success");
  });
});

// --- Translate Page Button ---
let currentPageState = "idle";

function updateTranslatePageBtn(state) {
  currentPageState = state;
  if (state === "translating") {
    translatePageLabel.textContent = "Translating...";
    translatePageBtn.disabled = true;
    translatePageBtn.classList.remove("revert");
  } else if (state === "translated") {
    translatePageLabel.textContent = "Revert Translation";
    translatePageBtn.disabled = false;
    translatePageBtn.classList.add("revert");
  } else {
    translatePageLabel.textContent = "Translate This Page";
    translatePageBtn.disabled = false;
    translatePageBtn.classList.remove("revert");
  }
}

// Query current state from content script
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) return;
  chrome.tabs.sendMessage(tabs[0].id, { action: "getPageTranslationState" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.state) updateTranslatePageBtn(response.state);
  });
});

translatePageBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    const action = currentPageState === "translated" ? "revertPage" : "translatePage";
    chrome.tabs.sendMessage(tabs[0].id, { action }, () => {
      if (action === "translatePage") {
        updateTranslatePageBtn("translating");
        // Embedded in the Context Kit popup's iframe → close the top-level popup.
        (window.top || window).close();
      } else {
        updateTranslatePageBtn("idle");
      }
    });
  });
});

const STATUS_ICONS = {
  success:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
};

let statusHideTimer = null;
let statusRemoveTimer = null;

function showStatus(message, type) {
  clearTimeout(statusHideTimer);
  clearTimeout(statusRemoveTimer);

  const icon = STATUS_ICONS[type] || "";
  statusEl.innerHTML = `${icon}<span class="status-text"></span>`;
  statusEl.querySelector(".status-text").textContent = message;
  statusEl.className = `status ${type}`;

  statusHideTimer = setTimeout(() => {
    statusEl.classList.add("hide");
    statusRemoveTimer = setTimeout(() => {
      statusEl.className = "status hidden";
    }, 200);
  }, 2200);
}
