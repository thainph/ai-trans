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
    styleAuto: "Auto",
    styleCasual: "Casual",
    stylePolite: "Polite",
    styleBusiness: "Business",
    targetLanguage: "Target Language",
    sourceLanguage: "Source Language",
    autoDetect: "Auto-detect",
    enableAutoSwap: "Auto-swap when source = target",
    saveSettings: "Save Settings",
    translateThisPage: "Translate This Page",
    translating: "Translating...",
    revertTranslation: "Revert Translation",
    selectTextHint: "Select text on any page to translate",
    settingsSaved: "Settings saved!",
    enterApiKey: "Please enter your OpenAI API key",
    enterGeminiApiKey: "Please enter your Gemini API key",
    selectOllamaModel: "Please select an Ollama model",
    enterCustomUrl: "Please enter a custom API URL",
    enterCustomApiKey: "Please enter a custom API key",
    selectCustomModel: "Please select a custom model",
    loadingModels: "Loading...",
    failedToLoad: "Failed to load",
    noModelsFound: "No models found",
    failedToLoadOpenAIModels: "Failed to load OpenAI models",
    failedToLoadCustomModels: "Failed to load custom models",
    manualEntry: "Manual entry",
    manualModelEntryTip: "Model list is not available for this provider. Please enter the model name manually.",
    customUrl: "API URL",
    selectModel: "-- Select model --",
    cannotConnectOllama: "Cannot connect to Ollama",
    uiLanguage: "Interface Language",
    languageEn: "English",
    languageZh: "中文",
    keyboardShortcuts: "Keyboard Shortcuts",
    translateSelection: "Translate Selection",
    translatePageShortcut: "Translate Page",
  },
  zh: {
    appTitle: "AI翻译助手",
    appSubtitle: "使用AI翻译任意文本",
    provider: "服务提供商",
    apiKey: "API密钥",
    model: "模型",
    ollamaUrl: "Ollama服务器地址",
    translationStyle: "翻译风格",
    styleAuto: "自动",
    styleCasual: "口语化",
    stylePolite: "礼貌",
    styleBusiness: "商务",
    targetLanguage: "目标语言",
    sourceLanguage: "源语言",
    autoDetect: "自动检测",
    enableAutoSwap: "源语言 = 目标语言时自动切换为英文",
    saveSettings: "保存设置",
    translateThisPage: "翻译此页面",
    translating: "翻译中...",
    revertTranslation: "恢复原文",
    selectTextHint: "选中任意页面上的文本即可翻译",
    settingsSaved: "设置已保存！",
    enterApiKey: "请输入OpenAI API密钥",
    enterGeminiApiKey: "请输入Gemini API密钥",
    selectOllamaModel: "请选择Ollama模型",
    enterCustomUrl: "请输入自定义API地址",
    enterCustomApiKey: "请输入自定义API密钥",
    selectCustomModel: "请选择自定义模型",
    loadingModels: "加载中...",
    failedToLoad: "加载失败",
    noModelsFound: "未找到模型",
    failedToLoadOpenAIModels: "加载OpenAI模型失败",
    failedToLoadCustomModels: "加载自定义模型失败",
    manualEntry: "手动输入",
    manualModelEntryTip: "当前服务商不支持自动获取模型列表，请手动输入模型名称。",
    customUrl: "API地址",
    selectModel: "-- 选择模型 --",
    cannotConnectOllama: "无法连接到Ollama",
    uiLanguage: "界面语言",
    languageEn: "English",
    languageZh: "中文",
    keyboardShortcuts: "键盘快捷键",
    translateSelection: "翻译划选",
    translatePageShortcut: "翻译整页",
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
const refreshOpenAIModelsBtn = document.getElementById("refreshOpenAIModels");
const customUrlInput = document.getElementById("customUrl");
const customApiKeyInput = document.getElementById("customApiKey");
const toggleCustomKeyBtn = document.getElementById("toggleCustomKey");
const customModelSelect = document.getElementById("customModel");
const customModelInput = document.getElementById("customModelInput");
const refreshCustomBtn = document.getElementById("refreshCustom");
const customSettings = document.getElementById("customSettings");
const saveSettingsBtn = document.getElementById("saveSettings");
const uiLanguageSelect = document.getElementById("uiLanguage");
const shortcutSelectionInput = document.getElementById("shortcutTranslateSelection");
const shortcutPageInput = document.getElementById("shortcutTranslatePage");
const clearShortcutSelectionBtn = document.getElementById("clearShortcutSelection");
const clearShortcutPageBtn = document.getElementById("clearShortcutPage");
const sourceLangSelect = document.getElementById("sourceLang");
const enableAutoSwapCheckbox = document.getElementById("enableAutoSwap");

// ===== State =====
let activeProvider = "openai";
let ollamaLoaded = false;
let openaiModelsLoaded = false;
let customModelsLoaded = false;
let savedOllamaModel = "";
let savedOpenaiModel = "";
let savedCustomModel = "";

// ===== Default keyboard shortcuts =====
const DEFAULT_SHORTCUTS = {
  shortcutTranslateSelection: "Ctrl+Shift+T",
  shortcutTranslatePage: "Ctrl+Shift+P",
};

// In-memory recorder state and pending values
const pendingShortcuts = {
  shortcutTranslateSelection: DEFAULT_SHORTCUTS.shortcutTranslateSelection,
  shortcutTranslatePage: DEFAULT_SHORTCUTS.shortcutTranslatePage,
};
let activeRecorder = null;
const IS_MAC = navigator.platform.toLowerCase().includes("mac");

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
      style: "auto",
      targetLang: "vietnamese",
      provider: "openai",
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "",
      openaiModel: "gpt-4o-mini",
      geminiApiKey: "",
      geminiModel: "gemini-2.5-flash",
      customUrl: "",
      customApiKey: "",
      customModel: "",
      uiLanguage: "en",
      shortcutTranslateSelection: DEFAULT_SHORTCUTS.shortcutTranslateSelection,
      shortcutTranslatePage: DEFAULT_SHORTCUTS.shortcutTranslatePage,
      sourceLang: "auto",
      enableAutoSwap: false,
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
      sourceLangSelect.value = data.sourceLang || "auto";
      enableAutoSwapCheckbox.checked = data.enableAutoSwap === true;
      openaiModelSelect.value = data.openaiModel;
      savedOpenaiModel = data.openaiModel;
      geminiModelSelect.value = data.geminiModel;

      if (!geminiModelSelect.value) geminiModelSelect.value = "gemini-2.5-flash";

      ollamaUrlInput.value = data.ollamaUrl;
      savedOllamaModel = data.ollamaModel;

      // Custom provider settings
      if (data.customUrl) customUrlInput.value = data.customUrl;
      if (data.customApiKey) customApiKeyInput.value = data.customApiKey;
      savedCustomModel = data.customModel;
      if (data.customModel) {
        customModelSelect.value = data.customModel;
        customModelInput.value = data.customModel;
      }

      // Restore shortcuts into the pending state and UI
      pendingShortcuts.shortcutTranslateSelection = data.shortcutTranslateSelection || DEFAULT_SHORTCUTS.shortcutTranslateSelection;
      pendingShortcuts.shortcutTranslatePage = data.shortcutTranslatePage || DEFAULT_SHORTCUTS.shortcutTranslatePage;
      renderShortcutInputs();

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
  customSettings.classList.toggle("hidden", provider !== "custom");

  if (provider === "ollama" && !ollamaLoaded) {
    loadOllamaModels(ollamaUrlInput.value.trim(), savedOllamaModel);
  }
  if (provider === "openai" && !openaiModelsLoaded && apiKeyInput.value.trim()) {
    loadOpenAIModels(apiKeyInput.value.trim(), savedOpenaiModel);
  }
  if (provider === "custom" && !customModelsLoaded && customUrlInput.value.trim() && customApiKeyInput.value.trim()) {
    loadCustomModels(customUrlInput.value.trim(), customApiKeyInput.value.trim(), savedCustomModel);
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

toggleCustomKeyBtn.addEventListener("click", () => {
  customApiKeyInput.type = customApiKeyInput.type === "password" ? "text" : "password";
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

// ===== OpenAI: fetch models dynamically =====
async function loadOpenAIModels(apiKey, selectedModel) {
  openaiModelsLoaded = true;
  openaiModelSelect.innerHTML = `<option value="">${t("loadingModels")}</option>`;
  openaiModelSelect.disabled = true;

  chrome.runtime.sendMessage({ action: "fetchOpenAIModels", apiKey }, (response) => {
    openaiModelSelect.disabled = false;

    if (chrome.runtime.lastError || !response?.success) {
      openaiModelsLoaded = false;
      // Fallback to hardcoded list on error
      const fallbackModels = [
        "gpt-4o-mini",
        "gpt-4o",
        "gpt-4-turbo",
        "gpt-4.1-nano",
        "gpt-4.1-mini",
        "gpt-4.1",
        "gpt-3.5-turbo",
      ];
      openaiModelSelect.innerHTML = fallbackModels
        .map((m) => `<option value="${m}">${m}</option>`)
        .join("");
      showStatus(response?.error || t("failedToLoadOpenAIModels"), "error");
      return;
    }

    const models = response.models;
    if (models.length === 0) {
      openaiModelsLoaded = false;
      openaiModelSelect.innerHTML = `<option value="">${t("noModelsFound")}</option>`;
      return;
    }

    openaiModelSelect.innerHTML = models
      .map((m) => `<option value="${m}">${m}</option>`)
      .join("");

    if (selectedModel && models.includes(selectedModel)) {
      openaiModelSelect.value = selectedModel;
    }
  });
}

refreshOpenAIModelsBtn.addEventListener("click", () => {
  loadOpenAIModels(apiKeyInput.value.trim(), openaiModelSelect.value);
});

// ===== Custom provider: sync model select and input =====
customModelSelect.addEventListener("change", () => {
  if (customModelSelect.value) {
    customModelInput.value = customModelSelect.value;
  }
});

customModelInput.addEventListener("input", () => {
  if (customModelInput.value.trim()) {
    customModelSelect.value = "";
  }
});

// ===== Custom provider: fetch models dynamically =====
async function loadCustomModels(url, apiKey, selectedModel) {
  customModelsLoaded = true;
  customModelSelect.innerHTML = `<option value="">${t("loadingModels")}</option>`;
  customModelSelect.disabled = true;

  chrome.runtime.sendMessage({ action: "fetchCustomModels", url, apiKey }, (response) => {
    customModelSelect.disabled = false;

    if (chrome.runtime.lastError || !response?.success) {
      customModelsLoaded = false;
      const errorMsg = response?.error || t("failedToLoadCustomModels");
      if (errorMsg === "MANUAL_INPUT_REQUIRED") {
        customModelSelect.innerHTML = `<option value="">${t("manualEntry")}</option>`;
        customModelInput.classList.remove("hidden");
        showStatus(t("manualModelEntryTip"), "info");
      } else {
        customModelSelect.innerHTML = `<option value="">${t("failedToLoad")}</option>`;
        customModelInput.classList.remove("hidden");
        showStatus(errorMsg, "error");
      }
      return;
    }

    const models = response.models;
    if (models.length === 0) {
      customModelsLoaded = false;
      customModelSelect.innerHTML = `<option value="">${t("noModelsFound")}</option>`;
      customModelInput.classList.remove("hidden");
      return;
    }

    customModelSelect.innerHTML = models
      .map((m) => `<option value="${m}">${m}</option>`)
      .join("");
    customModelInput.classList.add("hidden");

    if (selectedModel && models.includes(selectedModel)) {
      customModelSelect.value = selectedModel;
    }
  });
}

refreshCustomBtn.addEventListener("click", () => {
  loadCustomModels(customUrlInput.value.trim(), customApiKeyInput.value.trim(), customModelSelect.value);
});

// ===== Shortcut capture (key recording) =====
function shortcutToStorage(combo) {
  // Normalize to a single canonical "Ctrl+..." form so content.js rules match on any OS
  return combo.replace(/Cmd/g, "Ctrl");
}

function shortcutToCommandApi(combo) {
  // Chrome commands API expects "Command+..." on Mac, "Ctrl+..." elsewhere
  return combo.replace(/Cmd/g, "Command");
}

function shortcutToDisplay(combo) {
  if (!combo) return "";
  if (!IS_MAC) return combo;
  return combo
    .replace(/Ctrl\+/g, "⌃")
    .replace(/Cmd\+/g, "⌘")
    .replace(/Alt\+/g, "⌥")
    .replace(/Shift\+/g, "⇧")
    .replace(/Space/g, "Space");
}

function normalizeKey(e) {
  const parts = [];
  const mod = e.ctrlKey || e.metaKey;
  if (mod) parts.push(IS_MAC ? "Cmd" : "Ctrl");
  if (e.altKey) parts.push(IS_MAC ? "Alt" : "Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) return null;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

function renderShortcutInputs() {
  if (shortcutSelectionInput) {
    shortcutSelectionInput.value = shortcutToDisplay(pendingShortcuts.shortcutTranslateSelection);
  }
  if (shortcutPageInput) {
    shortcutPageInput.value = shortcutToDisplay(pendingShortcuts.shortcutTranslatePage);
  }
}

function setRecorder(input) {
  if (activeRecorder && activeRecorder !== input) {
    activeRecorder.classList.remove("recording");
  }
  if (activeRecorder === input) {
    activeRecorder.classList.remove("recording");
    activeRecorder = null;
    return;
  }
  activeRecorder = input;
  input.classList.add("recording");
  input.value = "Press keys...";
  input.focus();
}

function handleRecorderKey(e) {
  if (!activeRecorder) return;
  if (e.key === "Escape") {
    e.preventDefault();
    activeRecorder.classList.remove("recording");
    activeRecorder = null;
    renderShortcutInputs();
    return;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    const key = activeRecorder === shortcutSelectionInput ? "shortcutTranslateSelection" : "shortcutTranslatePage";
    pendingShortcuts[key] = "";
    activeRecorder.classList.remove("recording");
    activeRecorder = null;
    renderShortcutInputs();
    return;
  }
  const combo = normalizeKey(e);
  if (!combo) return;
  e.preventDefault();
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    // A bare key without modifiers is not a useful shortcut
    showStatus("Please include Ctrl / Cmd / Alt / Shift", "error");
    return;
  }
  const key = activeRecorder === shortcutSelectionInput ? "shortcutTranslateSelection" : "shortcutTranslatePage";
  pendingShortcuts[key] = shortcutToStorage(combo);
  activeRecorder.classList.remove("recording");
  activeRecorder = null;
  renderShortcutInputs();
}

if (shortcutSelectionInput) {
  shortcutSelectionInput.addEventListener("focus", () => setRecorder(shortcutSelectionInput));
  shortcutSelectionInput.addEventListener("click", () => setRecorder(shortcutSelectionInput));
  shortcutSelectionInput.addEventListener("blur", () => {
    if (activeRecorder === shortcutSelectionInput) {
      activeRecorder.classList.remove("recording");
      activeRecorder = null;
    }
  });
}
if (shortcutPageInput) {
  shortcutPageInput.addEventListener("focus", () => setRecorder(shortcutPageInput));
  shortcutPageInput.addEventListener("click", () => setRecorder(shortcutPageInput));
  shortcutPageInput.addEventListener("blur", () => {
    if (activeRecorder === shortcutPageInput) {
      activeRecorder.classList.remove("recording");
      activeRecorder = null;
    }
  });
}
document.addEventListener("keydown", handleRecorderKey, true);

if (clearShortcutSelectionBtn) {
  clearShortcutSelectionBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    pendingShortcuts.shortcutTranslateSelection = "";
    renderShortcutInputs();
    if (shortcutSelectionInput) shortcutSelectionInput.focus();
  });
}
if (clearShortcutPageBtn) {
  clearShortcutPageBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    pendingShortcuts.shortcutTranslatePage = "";
    renderShortcutInputs();
    if (shortcutPageInput) shortcutPageInput.focus();
  });
}

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
  if (activeProvider === "custom") {
    if (!customUrlInput.value.trim()) {
      showStatus(t("enterCustomUrl"), "error");
      return;
    }
    if (!customApiKeyInput.value.trim()) {
      showStatus(t("enterCustomApiKey"), "error");
      return;
    }
    // Allow either select or manual input for model
    const modelValue = customModelInput.value.trim() || customModelSelect.value;
    if (!modelValue) {
      showStatus(t("selectCustomModel"), "error");
      return;
    }
  }

  // Validate: if a shortcut is set, it must include at least one modifier
  for (const k of ["shortcutTranslateSelection", "shortcutTranslatePage"]) {
    const v = pendingShortcuts[k];
    if (v && !/(Ctrl|Cmd|Alt|Shift)/.test(v)) {
      showStatus("Shortcuts must include Ctrl / Cmd / Alt / Shift", "error");
      return;
    }
  }

  const settings = {
    provider: activeProvider,
    apiKey: apiKeyInput.value.trim(),
    openaiModel: openaiModelSelect.value,
    geminiApiKey: geminiApiKeyInput.value.trim(),
    geminiModel: geminiModelSelect.value,
    ollamaUrl: ollamaUrlInput.value.trim() || "http://localhost:11434",
    ollamaModel: ollamaModelSelect.value,
    customUrl: customUrlInput.value.trim(),
    customApiKey: customApiKeyInput.value.trim(),
    customModel: customModelInput.value.trim() || customModelSelect.value,
    style: document.querySelector('input[name="style"]:checked')?.value || "auto",
    targetLang: targetLangSelect.value,
    sourceLang: sourceLangSelect.value,
    enableAutoSwap: enableAutoSwapCheckbox.checked,
    uiLanguage: currentLocale,
    shortcutTranslateSelection:
      pendingShortcuts.shortcutTranslateSelection || DEFAULT_SHORTCUTS.shortcutTranslateSelection,
    shortcutTranslatePage:
      pendingShortcuts.shortcutTranslatePage || DEFAULT_SHORTCUTS.shortcutTranslatePage,
  };

  chrome.storage.sync.set(settings, () => {
    // Sync Chrome's global shortcut bindings so the browser-level commands work
    try {
      chrome.commands.update({
        command: "translate-selection",
        shortcut: shortcutToCommandApi(settings.shortcutTranslateSelection),
      });
      chrome.commands.update({
        command: "translate-page",
        shortcut: shortcutToCommandApi(settings.shortcutTranslatePage),
      });
    } catch (e) {
      // chrome.commands.update can throw on invalid combos; ignore and rely on suggested_key
    }
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
    updateTranslatePageBtn(action === "translatePage" ? "translating" : "idle");
    chrome.tabs.sendMessage(tabs[0].id, { action }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        updateTranslatePageBtn("idle");
      } else {
        // Update to final state based on what was done
        updateTranslatePageBtn(action === "translatePage" ? "translated" : "idle");
      }
      window.close();
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
