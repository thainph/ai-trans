const apiKeyInput = document.getElementById("apiKey");
const toggleKeyBtn = document.getElementById("toggleKey");
const saveKeyBtn = document.getElementById("saveKey");
const statusEl = document.getElementById("status");
const styleRadios = document.querySelectorAll('input[name="style"]');
const targetLangSelect = document.getElementById("targetLang");
const translatePageBtn = document.getElementById("translatePage");
const providerTabs = document.querySelectorAll(".provider-tab");
const openaiSettings = document.getElementById("openaiSettings");
const ollamaSettings = document.getElementById("ollamaSettings");
const openaiModelSelect = document.getElementById("openaiModel");
const ollamaUrlInput = document.getElementById("ollamaUrl");
const ollamaModelSelect = document.getElementById("ollamaModel");
const saveOllamaBtn = document.getElementById("saveOllama");
const refreshOllamaBtn = document.getElementById("refreshOllama");

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
  },
  (data) => {
    if (data.apiKey) apiKeyInput.value = data.apiKey;
    const radio = document.querySelector(`input[name="style"][value="${data.style}"]`);
    if (radio) radio.checked = true;
    targetLangSelect.value = data.targetLang;
    openaiModelSelect.value = data.openaiModel;
    ollamaUrlInput.value = data.ollamaUrl;
    switchProvider(data.provider);
    loadOllamaModels(data.ollamaUrl, data.ollamaModel);
  }
);

// Provider tabs
function switchProvider(provider) {
  providerTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });
  openaiSettings.classList.toggle("hidden", provider !== "openai");
  ollamaSettings.classList.toggle("hidden", provider !== "ollama");
  chrome.storage.sync.set({ provider });
}

providerTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    switchProvider(tab.dataset.provider);
    showStatus("Provider switched!", "success");
  });
});

// Toggle API key visibility
toggleKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

// Save OpenAI settings
saveKeyBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showStatus("Please enter an API key", "error");
    return;
  }
  chrome.storage.sync.set({ apiKey: key, openaiModel: openaiModelSelect.value }, () => {
    showStatus("OpenAI settings saved!", "success");
  });
});

// Ollama: fetch models via background script (avoids CORS)
async function loadOllamaModels(url, selectedModel) {
  const base = url || ollamaUrlInput.value.trim() || "http://localhost:11434";
  ollamaModelSelect.innerHTML = `<option value="">Loading...</option>`;
  ollamaModelSelect.disabled = true;

  chrome.runtime.sendMessage({ action: "fetchOllamaModels", url: base }, (response) => {
    ollamaModelSelect.disabled = false;

    if (chrome.runtime.lastError || !response?.success) {
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

    if (selectedModel && models.includes(selectedModel)) {
      ollamaModelSelect.value = selectedModel;
    } else {
      ollamaModelSelect.value = models[0];
      // Auto-save so stale model name gets replaced
      chrome.storage.sync.set({ ollamaModel: models[0] });
    }
  });
}

refreshOllamaBtn.addEventListener("click", () => {
  loadOllamaModels(ollamaUrlInput.value.trim(), ollamaModelSelect.value);
});

// Save Ollama settings
saveOllamaBtn.addEventListener("click", () => {
  const url = ollamaUrlInput.value.trim() || "http://localhost:11434";
  const model = ollamaModelSelect.value;
  if (!model) {
    showStatus("Please select a model", "error");
    return;
  }
  chrome.storage.sync.set({ ollamaUrl: url, ollamaModel: model }, () => {
    showStatus("Ollama settings saved!", "success");
  });
});

// Save style on change
styleRadios.forEach((radio) => {
  radio.addEventListener("change", (e) => {
    chrome.storage.sync.set({ style: e.target.value }, () => {
      showStatus("Style updated!", "success");
    });
  });
});

// Save target language on change
targetLangSelect.addEventListener("change", (e) => {
  chrome.storage.sync.set({ targetLang: e.target.value }, () => {
    showStatus("Target language updated!", "success");
  });
});

// --- Translate Page Button ---
let currentPageState = "idle";

function updateTranslatePageBtn(state) {
  currentPageState = state;
  if (state === "translating") {
    translatePageBtn.textContent = "Translating...";
    translatePageBtn.disabled = true;
    translatePageBtn.classList.remove("revert");
  } else if (state === "translated") {
    translatePageBtn.textContent = "Revert Translation";
    translatePageBtn.disabled = false;
    translatePageBtn.classList.add("revert");
  } else {
    translatePageBtn.textContent = "Translate This Page";
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
        window.close();
      } else {
        updateTranslatePageBtn("idle");
      }
    });
  });
});

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  setTimeout(() => {
    statusEl.className = "status hidden";
  }, 2000);
}
