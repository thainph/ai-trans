// Translator (service worker side): the only place that calls LLM APIs.

import { errorMessage } from '../../../shared/errors';
import { fail, ok, onTargetMessage, type Result } from '../../../shared/messaging';
import { languageName } from '../shared/languages';
import { TRANSLATOR_TARGET, type TranslatorRequest, type TranslatorResponses } from '../shared/messages';
import {
  DEFAULT_SETTINGS,
  type Provider,
  SEEDED_SETTINGS,
  type TranslationStyle,
  type TranslatorSettings,
} from '../shared/settings';
import {
  buildRequestBody,
  buildTranslatePrompt,
  CHUNK_CHARS,
  type LLMReply,
  mapLimit,
  parseLLMResponse,
  splitForTranslation,
  splitOuterWhitespace,
  stripTextTags,
  wrapText,
} from './llm';

// Initialize defaults on first install, fill in missing ones on update.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set(SEEDED_SETTINGS);
  } else {
    chrome.storage.sync.get(Object.keys(SEEDED_SETTINGS), (data) => {
      const missing: Partial<TranslatorSettings> = {};
      for (const [key, value] of Object.entries(SEEDED_SETTINGS)) {
        if (data[key] === undefined || data[key] === null) {
          Object.assign(missing, { [key]: value });
        }
      }
      if (Object.keys(missing).length > 0) {
        chrome.storage.sync.set(missing);
      }
    });
  }

  // Strip Origin header for localhost requests (Ollama CORS fix)
  const stripOrigin = (id: number, host: string): chrome.declarativeNetRequest.Rule => ({
    id,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [{ header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE }],
    },
    condition: {
      urlFilter: `||${host}`,
      resourceTypes: [
        chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
        chrome.declarativeNetRequest.ResourceType.OTHER,
      ],
    },
  });
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: [stripOrigin(1, 'localhost'), stripOrigin(2, '127.0.0.1')],
  });
});

const STYLE_PROMPTS: Record<TranslationStyle, string> = {
  casual: 'Use a casual, friendly, conversational tone',
  polite: 'Use a polite, respectful, and formal tone',
  business: 'Use a formal, professional business tone',
};

const styleInstruction = (style: string) => STYLE_PROMPTS[style as TranslationStyle] || STYLE_PROMPTS.casual;

onTargetMessage<TranslatorRequest>(TRANSLATOR_TARGET, (request) => {
  switch (request.type) {
    case 'translate':
      return reply<'translate'>(
        handleTranslate(request.text, request.sourceLang, request.targetLang, request.style).then((translation) => ({
          translation,
        })),
      );
    case 'fetch-ollama-models':
      return reply<'fetch-ollama-models'>(fetchOllamaModels(request.url).then((models) => ({ models })));
    case 'translate-batch':
      return reply<'translate-batch'>(
        handleTranslateBatch(request.texts, request.sourceLang, request.targetLang, request.style).then(
          (translations) => ({ translations }),
        ),
      );
    case 'grammar-check':
      return reply<'grammar-check'>(handleGrammarCheck(request.text).then((corrected) => ({ corrected })));
  }
});

/** The payload of a successful response to request type `K`. */
type Payload<K extends keyof TranslatorResponses> = Omit<Extract<TranslatorResponses[K], { ok: true }>, 'ok'>;

/** Wrap a handler's value (or error) in the response type of request type `K`. */
function reply<K extends keyof TranslatorResponses>(work: Promise<Payload<K>>): Promise<Result<Payload<K>>> {
  return work.then(ok, fail);
}

async function fetchOllamaModels(url: string): Promise<string[]> {
  const base = (url || DEFAULT_SETTINGS.ollamaUrl).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/api/tags`);
  } catch (err) {
    throw new Error(`Cannot connect to ${base} — ${errorMessage(err)}`);
  }
  if (!response.ok) {
    throw new Error(`Ollama error ${response.status}`);
  }
  const data = (await response.json()) as { models?: { name: string }[] };
  return (data.models || []).map((m) => m.name);
}

interface ProviderConfig {
  provider: Provider;
  url: string;
  model: string;
  headers: Record<string, string>;
}

async function getProviderConfig(): Promise<ProviderConfig> {
  // No defaults here: empty values fall back below, like values never saved.
  const data = (await chrome.storage.sync.get([
    'provider',
    'apiKey',
    'ollamaUrl',
    'ollamaModel',
    'openaiModel',
    'geminiApiKey',
    'geminiModel',
  ])) as Partial<TranslatorSettings>;
  const provider = data.provider || DEFAULT_SETTINGS.provider;

  if (provider === 'ollama') {
    if (!data.ollamaModel) {
      throw new Error('No Ollama model selected. Open extension settings and select a model.');
    }
    const base = (data.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/+$/, '');
    return {
      provider: 'ollama',
      url: `${base}/api/chat`,
      model: data.ollamaModel,
      headers: { 'Content-Type': 'application/json' },
    };
  }

  if (provider === 'gemini') {
    if (!data.geminiApiKey) {
      throw new Error('No Gemini API key set. Click the extension icon to configure.');
    }
    const model = data.geminiModel || DEFAULT_SETTINGS.geminiModel;
    return {
      provider: 'gemini',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      model,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': data.geminiApiKey,
      },
    };
  }

  if (!data.apiKey) {
    throw new Error('No API key set. Click the extension icon to configure.');
  }
  return {
    provider: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    model: data.openaiModel || DEFAULT_SETTINGS.openaiModel,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.apiKey}`,
    },
  };
}

let cachedConfig: ProviderConfig | null = null;
let cachedConfigTime = 0;

async function getCachedProviderConfig(): Promise<ProviderConfig> {
  const now = Date.now();
  if (cachedConfig && now - cachedConfigTime < 5000) return cachedConfig;
  cachedConfig = await getProviderConfig();
  cachedConfigTime = now;
  return cachedConfig;
}

/** truncated = the model hit its output limit. */
async function callLLM(systemPrompt: string, userContent: string): Promise<LLMReply> {
  const config = await getCachedProviderConfig();
  const body = buildRequestBody(config.provider, config.model, systemPrompt, userContent);

  let response: Response;
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Cannot connect to ${config.url} — ${errorMessage(err)}`);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`API error ${response.status} from ${config.url}: ${errBody}`);
  }

  return parseLLMResponse(config.provider, await response.json());
}

async function handleTranslateBatch(
  texts: string[],
  sourceLang: string,
  targetLang: string,
  style: string,
): Promise<string[]> {
  const source = languageName(sourceLang);
  const target = languageName(targetLang);

  // Numbered format — more reliable than separator for LLMs
  const numbered = texts.map((t, i) => `[${i}] ${t}`).join('\n');

  const systemPrompt = `You are a translator. Translate each numbered line from ${source} to ${target}.\n${styleInstruction(style)}.\nKeep the [N] prefix on each line. Return ONLY the translated lines, one per line, same order.`;

  const { text: raw } = await callLLM(systemPrompt, numbered);

  // Parse numbered response
  const result = new Array<string>(texts.length);
  for (const line of raw.split('\n')) {
    const match = line.match(/^\[(\d+)\]\s*(.+)/);
    if (match) {
      const idx = parseInt(match[1]!, 10);
      if (idx >= 0 && idx < texts.length) {
        result[idx] = match[2]!.trim();
      }
    }
  }

  // Fill missing with original
  for (let i = 0; i < texts.length; i++) {
    if (!result[i]) result[i] = texts[i]!;
  }
  return result;
}

async function handleGrammarCheck(text: string): Promise<string> {
  const systemPrompt =
    'You are an English grammar and spelling corrector. Fix grammar, spelling, ' +
    'and punctuation while preserving the original meaning and tone. Return ONLY ' +
    'the corrected English text — no explanations, quotes, or extra formatting. ' +
    'If it is already correct, return it unchanged.';

  const { text: corrected } = await callLLM(systemPrompt, text);
  return corrected;
}

const TRUNCATED_NOTICE = '\n\n⚠️ The translation may be incomplete: the AI model stopped at its output limit.';

async function handleTranslate(text: string, sourceLang: string, targetLang: string, style: string): Promise<string> {
  const systemPrompt = buildTranslatePrompt(languageName(sourceLang), languageName(targetLang), styleInstruction(style));

  // Long selections are translated in chunks so no request exceeds the
  // model's context/output limits; whitespace between chunks is kept as-is.
  const segments = splitForTranslation(text, CHUNK_CHARS);
  const { provider } = await getCachedProviderConfig();
  const concurrency = provider === 'ollama' ? 1 : 3;
  let truncated = false;

  const parts = await mapLimit(segments, concurrency, async (segment) => {
    const { lead, core, trail } = splitOuterWhitespace(segment);
    if (!core) return segment;
    const result = await callLLM(systemPrompt, wrapText(core));
    if (result.truncated) truncated = true;
    return lead + stripTextTags(result.text) + trail;
  });

  return parts.join('').trim() + (truncated ? TRUNCATED_NOTICE : '');
}
