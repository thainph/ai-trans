// --- Default Settings ---
const DEFAULT_SETTINGS = {
  targetLang: "vietnamese",
  style: "casual",
  popupWidth: 340,
  provider: "openai",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "",
  openaiModel: "gpt-4o-mini",
};

// Initialize defaults on first install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.sync.set(DEFAULT_SETTINGS);
  } else {
    chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (data) => {
      const missing = {};
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (data[key] === undefined || data[key] === null) {
          missing[key] = value;
        }
      }
      if (Object.keys(missing).length > 0) {
        chrome.storage.sync.set(missing);
      }
    });
  }

  // Strip Origin header for localhost requests (Ollama CORS fix)
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "Origin", operation: "remove" }],
        },
        condition: {
          urlFilter: "||localhost",
          resourceTypes: ["xmlhttprequest", "other"],
        },
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "Origin", operation: "remove" }],
        },
        condition: {
          urlFilter: "||127.0.0.1",
          resourceTypes: ["xmlhttprequest", "other"],
        },
      },
    ],
  });
});

const STYLE_PROMPTS = {
  casual: "Use a casual, friendly, conversational tone",
  polite: "Use a polite, respectful, and formal tone",
  business: "Use a formal, professional business tone",
};

const LANG_NAMES = {
  english: "English",
  japanese: "Japanese",
  vietnamese: "Vietnamese",
  chinese: "Chinese",
  korean: "Korean",
  french: "French",
  german: "German",
  spanish: "Spanish",
  portuguese: "Portuguese",
  russian: "Russian",
  thai: "Thai",
  indonesian: "Indonesian",
  italian: "Italian",
  dutch: "Dutch",
  arabic: "Arabic",
  hindi: "Hindi",
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    handleTranslate(request.text, request.sourceLang, request.targetLang, request.style)
      .then((translation) => sendResponse({ success: true, translation }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === "fetchOllamaModels") {
    fetchOllamaModels(request.url)
      .then((models) => sendResponse({ success: true, models }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === "translateBatch") {
    handleTranslateBatch(request.texts, request.sourceLang, request.targetLang, request.style)
      .then((translations) => sendResponse({ success: true, translations }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchOllamaModels(url) {
  const base = (url || "http://localhost:11434").replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${base}/api/tags`);
  } catch (err) {
    throw new Error(`Cannot connect to ${base} — ${err.message}`);
  }
  if (!response.ok) {
    throw new Error(`Ollama error ${response.status}`);
  }
  const data = await response.json();
  return (data.models || []).map((m) => m.name);
}

async function getProviderConfig() {
  const data = await chrome.storage.sync.get([
    "provider", "apiKey", "ollamaUrl", "ollamaModel", "openaiModel",
  ]);
  const provider = data.provider || "openai";

  if (provider === "ollama") {
    if (!data.ollamaModel) {
      throw new Error("No Ollama model selected. Open extension settings and select a model.");
    }
    const base = (data.ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
    return {
      provider: "ollama",
      url: `${base}/api/chat`,
      model: data.ollamaModel,
      headers: { "Content-Type": "application/json" },
    };
  }

  if (!data.apiKey) {
    throw new Error("No API key set. Click the extension icon to configure.");
  }
  return {
    provider: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    model: data.openaiModel || "gpt-4o-mini",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.apiKey}`,
    },
  };
}

let _cachedConfig = null;
let _cachedConfigTime = 0;

async function getCachedProviderConfig() {
  const now = Date.now();
  if (_cachedConfig && now - _cachedConfigTime < 5000) return _cachedConfig;
  _cachedConfig = await getProviderConfig();
  _cachedConfigTime = now;
  return _cachedConfig;
}

async function callLLM(systemPrompt, userContent, maxTokens) {
  const config = await getCachedProviderConfig();

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  const body = config.provider === "ollama"
    ? { model: config.model, messages, stream: false, options: { temperature: 0.3 } }
    : { model: config.model, messages, temperature: 0.3, max_tokens: maxTokens };

  let response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Cannot connect to ${config.url} — ${err.message}`);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`API error ${response.status} from ${config.url}: ${errBody}`);
  }

  const result = await response.json();

  // Ollama native: { message: { content: "..." } }
  // OpenAI: { choices: [{ message: { content: "..." } }] }
  if (config.provider === "ollama") {
    return result.message.content.trim();
  }
  return result.choices[0].message.content.trim();
}

async function handleTranslateBatch(texts, sourceLang, targetLang, style) {
  const styleInstruction = STYLE_PROMPTS[style] || STYLE_PROMPTS.casual;
  const source = LANG_NAMES[sourceLang] || sourceLang;
  const target = LANG_NAMES[targetLang] || targetLang;

  // Numbered format — more reliable than separator for LLMs
  const numbered = texts.map((t, i) => `[${i}] ${t}`).join("\n");

  const systemPrompt = `You are a translator. Translate each numbered line from ${source} to ${target}.\n${styleInstruction}.\nKeep the [N] prefix on each line. Return ONLY the translated lines, one per line, same order.`;

  const raw = await callLLM(systemPrompt, numbered, 4096);

  // Parse numbered response
  const result = new Array(texts.length);
  for (const line of raw.split("\n")) {
    const match = line.match(/^\[(\d+)\]\s*(.+)/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx >= 0 && idx < texts.length) {
        result[idx] = match[2].trim();
      }
    }
  }

  // Fill missing with original
  for (let i = 0; i < texts.length; i++) {
    if (!result[i]) result[i] = texts[i];
  }
  return result;
}

async function handleTranslate(text, sourceLang, targetLang, style) {
  const styleInstruction = STYLE_PROMPTS[style] || STYLE_PROMPTS.casual;
  const source = LANG_NAMES[sourceLang] || sourceLang;
  const target = LANG_NAMES[targetLang] || targetLang;

  const systemPrompt = `You are a translator. Translate the following text from ${source} to ${target}.\n${styleInstruction}.\nReturn ONLY the translated text, no explanations or extra formatting.`;

  return callLLM(systemPrompt, text, 1024);
}
