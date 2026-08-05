// ===== Internationalization (i18n) =====
const MESSAGES = {};
let currentLocale = "en";

function loadMessages(locale) {
  const lang = locale || "en";
  if (MESSAGES[lang]) return MESSAGES[lang];

  try {
    MESSAGES[lang] = chrome.i18n.getMessage(lang) ? { _locale: lang } : null;
    if (!MESSAGES[lang]) {
      MESSAGES[lang] = { _locale: lang };
    }
  } catch (e) {
    MESSAGES[lang] = { _locale: lang };
  }
  return MESSAGES[lang];
}

function getMessage(key) {
  try {
    return chrome.i18n.getMessage(key) || document.querySelector(`[data-i18n="${key}"]`)?.textContent || key;
  } catch (e) {
    return key;
  }
}

function applyI18n() {
  // Apply to elements with data-i18n attribute
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = getMessage(key);
  });

  // Apply to option elements with data-i18n-option attribute
  document.querySelectorAll("[data-i18n-option]").forEach((el) => {
    const key = el.getAttribute("data-i18n-option");
    el.textContent = getMessage(key);
  });

  // Update HTML lang attribute
  document.documentElement.lang = currentLocale;
}

// ===== Default translations (fallback when i18n not available) =====
const DEFAULT_TRANSLATIONS = {
  en: {
    appTitle: "AI Translator",
    appSubtitle: "Translate any text with AI",
    provider: "Provider",
    apiKey: "API Key",
    model: "Model",
    ollamaUrl: "Ollama URL",
    translationStyle: "Translation Style",
    styleCasual: "Casual",
    stylePolite: "Polite",
    styleBusiness: "Business",
    targetLanguage: "Target Language",
    saveSettings: "Save Settings",
    translateThisPage: "Translate This Page",
    translating: "Translating...",
    revertTranslation: "Revert Translation",
    selectTextHint: "Select text on any page to translate",
    settingsSaved: "Settings saved!",
    enterApiKey: "Please enter your OpenAI API key",
    enterGeminiApiKey: "Please enter your Gemini API key",
    selectOllamaModel: "Please select an Ollama model",
    loadingModels: "Loading...",
    failedToLoad: "Failed to load",
    noModelsFound: "No models found",
    selectModel: "-- Select model --",
    cannotConnectOllama: "Cannot connect to Ollama",
    uiLanguage: "Interface Language",
    languageEn: "English",
    languageZh: "中文",
  },
  zh: {
    appTitle: "AI翻译助手",
    appSubtitle: "使用AI翻译任意文本",
    provider: "服务提供商",
    apiKey: "API密钥",
    model: "模型",
    ollamaUrl: "Ollama服务器地址",
    translationStyle: "翻译风格",
    styleCasual: "口语化",
    stylePolite: "礼貌",
    styleBusiness: "商务",
    targetLanguage: "目标语言",
    saveSettings: "保存设置",
    translateThisPage: "翻译此页面",
    translating: "翻译中...",
    revertTranslation: "恢复原文",
    selectTextHint: "选中任意页面上的文本即可翻译",
    settingsSaved: "设置已保存！",
    enterApiKey: "请输入OpenAI API密钥",
    enterGeminiApiKey: "请输入Gemini API密钥",
    selectOllamaModel: "请选择Ollama模型",
    loadingModels: "加载中...",
    failedToLoad: "加载失败",
    noModelsFound: "未找到模型",
    selectModel: "-- 选择模型 --",
    cannotConnectOllama: "无法连接到Ollama",
    uiLanguage: "界面语言",
    languageEn: "English",
    languageZh: "中文",
  },
};

function t(key) {
  return DEFAULT_TRANSLATIONS[currentLocale]?.[key] || DEFAULT_TRANSLATIONS.en[key] || key;
}

function applyTranslations() {
  // Apply translations to all i18n elements
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });

  document.querySelectorAll("[data-i18n-option]").forEach((el) => {
    const key = el.getAttribute("data-i18n-option");
    el.textContent = t(key);
  });

  document.documentElement.lang = currentLocale;
}

// ===== Element references =====
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
const uiLanguageSelect = document.getElementById("uiLanguage");

// ===== State =====
let activeProvider = "openai";
let ollamaLoaded = false;
let savedOllamaModel = "";

// ===== Populate dropdowns with translations =====
function populateDropdowns() {
  // OpenAI models
  const openaiModels = [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4-turbo",
    "gpt-4.1-nano",
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-3.5-turbo",
  ];
  openaiModelSelect.innerHTML = openaiModels
    .map((m) => `<option value="${m}">${m}</option>`)
    .join("");

  // Gemini models
  const geminiModels = [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
  ];
  geminiModelSelect.innerHTML = geminiModels
    .map((m) => `<option value="${m}">${m}</option>`)
    .join("");

  // Target languages
  const languages = [
    { value: "vietnamese", label: "Vietnamese (Tiếng Việt)" },
    { value: "english", label: "English" },
    { value: "japanese", label: "Japanese (日本語)" },
    { value: "chinese", label: "Chinese (中文)" },
    { value: "korean", label: "Korean (한국어)" },
    { value: "french", label: "French (Français)" },
    { value: "german", label: "German (Deutsch)" },
    { value: "spanish", label: "Spanish (Español)" },
    { value: "portuguese", label: "Portuguese (Português)" },
    { value: "russian", label: "Russian (Русский)" },
    { value: "thai", label: "Thai (ไทย)" },
    { value: "indonesian", label: "Indonesian (Bahasa)" },
    { value: "italian", label: "Italian (Italiano)" },
    { value: "dutch", label: "Dutch (Nederlands)" },
    { value: "arabic", label: "Arabic (العربية)" },
    { value: "hindi", label: "Hindi (हिन्दी)" },
  ];
  targetLangSelect.innerHTML = languages
    .map((l) => `<option value="${l.value}">${l.label}</option>`)
    .join("");
}

// ===== Initialize =====
function init() {
  populateDropdowns();

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
      uiLanguage: "en",
    },
    (data) => {
      // Set UI language
      currentLocale = data.uiLanguage || "en";
      uiLanguageSelect.value = currentLocale;
      applyTranslations();

      if (data.apiKey) apiKeyInput.value = data.apiKey;
      if (data.geminiApiKey) geminiApiKeyInput.value = data.geminiApiKey;

      const radio = document.querySelector(`input[name="style"][value="${data.style}"]`);
      if (radio) radio.checked = true;

      targetLangSelect.value = data.targetLang;
      openaiModelSelect.value = data.openaiModel;
      geminiModelSelect.value = data.geminiModel;

      if (!geminiModelSelect.value) geminiModelSelect.value = "gemini-2.5-flash";

      ollamaUrlInput.value = data.ollamaUrl;
      savedOllamaModel = data.ollamaModel;

      switchProvider(data.provider);
    }
  );
}

// ===== UI Language Selector =====
uiLanguageSelect.addEventListener("change", (e) => {
  currentLocale = e.target.value;
  applyTranslations();
  // Save the preference
  chrome.storage.sync.set({ uiLanguage: currentLocale });
});

// ===== Provider tabs =====
function switchProvider(provider) {
  activeProvider = provider;
  providerTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });
  openaiSettings.classList.toggle("hidden", provider !== "openai");
  geminiSettings.classList.toggle("hidden", provider !== "gemini");
  ollamaSettings.classList.toggle("hidden", provider !== "ollama");

  if (provider === "ollama" && !ollamaLoaded) {
    loadOllamaModels(ollamaUrlInput.value.trim(), savedOllamaModel);
  }
}

providerTabs.forEach((tab) => {
  tab.addEventListener("click", () => switchProvider(tab.dataset.provider));
});

// ===== Toggle API key visibility =====
toggleKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

toggleGeminiKeyBtn.addEventListener("click", () => {
  geminiApiKeyInput.type = geminiApiKeyInput.type === "password" ? "text" : "password";
});

// ===== Ollama: fetch models =====
async function loadOllamaModels(url, selectedModel) {
  const base = url || ollamaUrlInput.value.trim() || "http://localhost:11434";
  ollamaLoaded = true;
  ollamaModelSelect.innerHTML = `<option value="">${t("loadingModels")}</option>`;
  ollamaModelSelect.disabled = true;

  chrome.runtime.sendMessage({ action: "fetchOllamaModels", url: base }, (response) => {
    ollamaModelSelect.disabled = false;

    if (chrome.runtime.lastError || !response?.success) {
      ollamaLoaded = false;
      ollamaModelSelect.innerHTML = `<option value="">${t("failedToLoad")}</option>`;
      showStatus(response?.error || t("cannotConnectOllama"), "error");
      return;
    }

    const models = response.models;
    if (models.length === 0) {
      ollamaModelSelect.innerHTML = `<option value="">${t("noModelsFound")}</option>`;
      return;
    }

    let options = `<option value="">${t("selectModel")}</option>`;
    options += models
      .map((name) => `<option value="${name}"${name === selectedModel ? " selected" : ""}>${name}</option>`)
      .join("");
    ollamaModelSelect.innerHTML = options;

    ollamaModelSelect.value = selectedModel && models.includes(selectedModel) ? selectedModel : models[0];
  });
}

refreshOllamaBtn.addEventListener("click", () => {
  loadOllamaModels(ollamaUrlInput.value.trim(), ollamaModelSelect.value);
});

// ===== Save settings =====
saveSettingsBtn.addEventListener("click", () => {
  if (activeProvider === "openai" && !apiKeyInput.value.trim()) {
    showStatus(t("enterApiKey"), "error");
    return;
  }
  if (activeProvider === "gemini" && !geminiApiKeyInput.value.trim()) {
    showStatus(t("enterGeminiApiKey"), "error");
    return;
  }
  if (activeProvider === "ollama" && !ollamaModelSelect.value) {
    showStatus(t("selectOllamaModel"), "error");
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
    uiLanguage: currentLocale,
  };

  chrome.storage.sync.set(settings, () => {
    showStatus(t("settingsSaved"), "success");
  });
});

// ===== Translate Page Button =====
let currentPageState = "idle";

function updateTranslatePageBtn(state) {
  currentPageState = state;
  if (state === "translating") {
    translatePageLabel.textContent = t("translating");
    translatePageBtn.disabled = true;
    translatePageBtn.classList.remove("revert");
  } else if (state === "translated") {
    translatePageLabel.textContent = t("revertTranslation");
    translatePageBtn.disabled = false;
    translatePageBtn.classList.add("revert");
  } else {
    translatePageLabel.textContent = t("translateThisPage");
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

// ===== Status toast =====
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

// Initialize on load
init();
