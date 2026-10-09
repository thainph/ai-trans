// Translator tab: provider settings (saved only on "Save Settings") and the
// "Translate This Page" toggle for the active tab.

import {
  callTranslator,
  type PageStateResponse,
  type PageTranslationState,
  TRANSLATOR_PAGE_TARGET,
  type TranslatorPageRequest,
} from '../shared/messages';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type Provider,
  saveSettings,
  type TranslationStyle,
  type TranslatorSettings,
} from '../shared/settings';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const apiKeyInput = $<HTMLInputElement>('apiKey');
const toggleKeyBtn = $<HTMLButtonElement>('toggleKey');
const statusEl = $<HTMLDivElement>('status');
const targetLangSelect = $<HTMLSelectElement>('targetLang');
const translatePageBtn = $<HTMLButtonElement>('translatePage');
const translatePageLabel = $<HTMLSpanElement>('translatePageLabel');
const providerTabs = document.querySelectorAll<HTMLButtonElement>('.provider-tab');
const openaiSettings = $<HTMLDivElement>('openaiSettings');
const geminiSettings = $<HTMLDivElement>('geminiSettings');
const ollamaSettings = $<HTMLDivElement>('ollamaSettings');
const openaiModelSelect = $<HTMLSelectElement>('openaiModel');
const geminiApiKeyInput = $<HTMLInputElement>('geminiApiKey');
const toggleGeminiKeyBtn = $<HTMLButtonElement>('toggleGeminiKey');
const geminiModelSelect = $<HTMLSelectElement>('geminiModel');
const ollamaUrlInput = $<HTMLInputElement>('ollamaUrl');
const ollamaModelSelect = $<HTMLSelectElement>('ollamaModel');
const refreshOllamaBtn = $<HTMLButtonElement>('refreshOllama');
const saveSettingsBtn = $<HTMLButtonElement>('saveSettings');

// Currently selected provider tab (UI only — not persisted until Save)
let activeProvider: Provider = DEFAULT_SETTINGS.provider;
// Ollama models are fetched from a server → load lazily, only when Ollama is active
let ollamaLoaded = false;
let savedOllamaModel = '';

ollamaUrlInput.placeholder = DEFAULT_SETTINGS.ollamaUrl;

// Load saved settings
void loadSettings(
  'apiKey',
  'style',
  'targetLang',
  'provider',
  'ollamaUrl',
  'ollamaModel',
  'openaiModel',
  'geminiApiKey',
  'geminiModel',
).then((data) => {
  if (data.apiKey) apiKeyInput.value = data.apiKey;
  if (data.geminiApiKey) geminiApiKeyInput.value = data.geminiApiKey;
  const radio = document.querySelector<HTMLInputElement>(`input[name="style"][value="${data.style}"]`);
  if (radio) radio.checked = true;
  targetLangSelect.value = data.targetLang;
  openaiModelSelect.value = data.openaiModel;
  geminiModelSelect.value = data.geminiModel;
  // Saved model may be a since-removed/deprecated one → fall back to default
  if (!geminiModelSelect.value) geminiModelSelect.value = DEFAULT_SETTINGS.geminiModel;
  ollamaUrlInput.value = data.ollamaUrl;
  savedOllamaModel = data.ollamaModel;
  // switchProvider lazy-loads Ollama models only when Ollama is the active provider
  switchProvider(data.provider);
});

// Provider tabs — switch the visible section only (no persistence)
function switchProvider(provider: Provider): void {
  activeProvider = provider;
  providerTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.provider === provider);
  });
  openaiSettings.classList.toggle('hidden', provider !== 'openai');
  geminiSettings.classList.toggle('hidden', provider !== 'gemini');
  ollamaSettings.classList.toggle('hidden', provider !== 'ollama');

  // Fetch Ollama models only when its tab is active, and only once
  if (provider === 'ollama' && !ollamaLoaded) {
    void loadOllamaModels(ollamaUrlInput.value.trim(), savedOllamaModel);
  }
}

providerTabs.forEach((tab) => {
  tab.addEventListener('click', () => switchProvider(tab.dataset.provider as Provider));
});

// Toggle API key visibility
toggleKeyBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

toggleGeminiKeyBtn.addEventListener('click', () => {
  geminiApiKeyInput.type = geminiApiKeyInput.type === 'password' ? 'text' : 'password';
});

// Ollama: fetch models via background script (avoids CORS). UI only — never persists.
async function loadOllamaModels(url: string, selectedModel: string): Promise<void> {
  const base = url || ollamaUrlInput.value.trim() || DEFAULT_SETTINGS.ollamaUrl;
  ollamaLoaded = true; // avoid duplicate concurrent loads while pending
  setOllamaOptions('Loading...');
  ollamaModelSelect.disabled = true;

  const response = await callTranslator({ type: 'fetch-ollama-models', url: base }).catch(() => undefined);
  ollamaModelSelect.disabled = false;

  if (!response?.ok) {
    ollamaLoaded = false; // allow retry on next tab switch / refresh
    setOllamaOptions('Failed to load');
    showStatus((response && !response.ok && response.error) || 'Cannot connect to Ollama', 'error');
    return;
  }

  const models = response.models;
  if (models.length === 0) {
    setOllamaOptions('No models found');
    return;
  }

  // Model names come from a server: text-only <option>s, never HTML.
  setOllamaOptions('-- Select model --', models);

  // Preselect the saved model if still available, otherwise the first one (UI only)
  ollamaModelSelect.value = selectedModel && models.includes(selectedModel) ? selectedModel : models[0]!;
}

/** Replace the model list: a placeholder (value "") followed by `models`. */
function setOllamaOptions(placeholder: string, models: string[] = []): void {
  ollamaModelSelect.replaceChildren(new Option(placeholder, ''), ...models.map((name) => new Option(name, name)));
}

refreshOllamaBtn.addEventListener('click', () => {
  void loadOllamaModels(ollamaUrlInput.value.trim(), ollamaModelSelect.value);
});

// --- Unified Save: nothing persists until this is clicked ---
saveSettingsBtn.addEventListener('click', () => {
  // Validate the active provider's required credential
  if (activeProvider === 'openai' && !apiKeyInput.value.trim()) {
    showStatus('Please enter your OpenAI API key', 'error');
    return;
  }
  if (activeProvider === 'gemini' && !geminiApiKeyInput.value.trim()) {
    showStatus('Please enter your Gemini API key', 'error');
    return;
  }
  if (activeProvider === 'ollama' && !ollamaModelSelect.value) {
    showStatus('Please select an Ollama model', 'error');
    return;
  }

  const style = document.querySelector<HTMLInputElement>('input[name="style"]:checked')?.value;
  const settings: Omit<TranslatorSettings, 'popupWidth' | 'popupHeight'> = {
    provider: activeProvider,
    apiKey: apiKeyInput.value.trim(),
    openaiModel: openaiModelSelect.value,
    geminiApiKey: geminiApiKeyInput.value.trim(),
    geminiModel: geminiModelSelect.value,
    ollamaUrl: ollamaUrlInput.value.trim() || DEFAULT_SETTINGS.ollamaUrl,
    ollamaModel: ollamaModelSelect.value,
    style: (style as TranslationStyle | undefined) || DEFAULT_SETTINGS.style,
    targetLang: targetLangSelect.value,
  };

  void saveSettings(settings).then(() => {
    showStatus('Settings saved!', 'success');
  });
});

// --- Translate Page Button ---
let currentPageState: PageTranslationState = 'idle';

function updateTranslatePageBtn(state: PageTranslationState): void {
  currentPageState = state;
  if (state === 'translating') {
    translatePageLabel.textContent = 'Translating...';
    translatePageBtn.disabled = true;
    translatePageBtn.classList.remove('revert');
  } else if (state === 'translated') {
    translatePageLabel.textContent = 'Revert Translation';
    translatePageBtn.disabled = false;
    translatePageBtn.classList.add('revert');
  } else {
    translatePageLabel.textContent = 'Translate This Page';
    translatePageBtn.disabled = false;
    translatePageBtn.classList.remove('revert');
  }
}

/** Page commands go to the top frame only: one translation per tab, not one per iframe. */
function sendToPage<R>(tabId: number, type: TranslatorPageRequest['type'], callback: (response?: R) => void): void {
  const request: TranslatorPageRequest = { target: TRANSLATOR_PAGE_TARGET, type };
  chrome.tabs.sendMessage(tabId, request, { frameId: 0 }, (response?: R) => {
    // No content script in the tab (system pages, not reloaded yet…).
    if (chrome.runtime.lastError) {
      if (type !== 'get-state') callback();
      return;
    }
    callback(response);
  });
}

// Query current state from content script
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs[0]?.id;
  if (tabId === undefined) return;
  sendToPage<PageStateResponse>(tabId, 'get-state', (response) => {
    if (response?.ok) updateTranslatePageBtn(response.state);
  });
});

translatePageBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId === undefined) return;
    const type = currentPageState === 'translated' ? 'revert-page' : 'translate-page';
    sendToPage(tabId, type, () => {
      if (type === 'translate-page') {
        updateTranslatePageBtn('translating');
        // Embedded in the Context Kit popup's iframe → close the top-level popup.
        (window.top || window).close();
      } else {
        updateTranslatePageBtn('idle');
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

let statusHideTimer: ReturnType<typeof setTimeout> | undefined;
let statusRemoveTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(message: string, type: keyof typeof STATUS_ICONS): void {
  clearTimeout(statusHideTimer);
  clearTimeout(statusRemoveTimer);

  statusEl.innerHTML = `${STATUS_ICONS[type]}<span class="status-text"></span>`;
  statusEl.querySelector('.status-text')!.textContent = message;
  statusEl.className = `status ${type}`;

  statusHideTimer = setTimeout(() => {
    statusEl.classList.add('hide');
    statusRemoveTimer = setTimeout(() => {
      statusEl.className = 'status hidden';
    }, 200);
  }, 2200);
}
