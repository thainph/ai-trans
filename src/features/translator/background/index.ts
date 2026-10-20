// Translator (service worker side): the only place that calls LLM APIs.

import { mapLimit } from '../../../shared/async';
import { errorMessage } from '../../../shared/errors';
import { fail, ok, onTargetMessage, type Result } from '../../../shared/messaging';
import { DevdyTranslateError, devdyTranslateStatus, needsDevdySettings, openSettings } from '../../devdy/api';
import { buildBatchInput, buildBatchPrompt, parseBatchResponse } from '../core/batch-protocol';
import { languageName } from '../shared/languages';
import {
  type BatchTranslation,
  type GrammarIssue,
  type StreamTranslateEvent,
  type StreamTranslateRequest,
  TRANSLATOR_TARGET,
  type TranslatorRequest,
  type TranslatorResponses,
} from '../shared/messages';
import {
  DEFAULT_SETTINGS,
  isProvider,
  type LLMProvider,
  loadSettings,
  type Provider,
  SEEDED_SETTINGS,
  type TranslationStyle,
  type TranslatorSettings,
} from '../shared/settings';
import { checkGrammarWithDevdy, translateBatchWithDevdy, translateTextWithDevdy } from './devdy';
import {
  buildRequestBody,
  buildTranslatePrompt,
  CANCELLED,
  CHUNK_CHARS,
  LLM_TIMEOUT_MS,
  type LLMReply,
  MODELS_TIMEOUT_MS,
  OLLAMA_TIMEOUT_MS,
  parseLLMResponse,
  signalWithTimeout,
  splitForTranslation,
  splitOuterWhitespace,
  stripTextTags,
  wrapText,
} from './llm';
import { syncOllamaCors } from './ollama-cors';
import { rejectReason, requestKey } from './sender';
import { serveStreamPort } from './stream-port';

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

  // Ollama CORS: (re)build the Origin-stripping rules (also replaces the old global ones).
  void syncOllamaCors();
});

const STYLE_PROMPTS: Record<TranslationStyle, string> = {
  casual: 'Use a casual, friendly, conversational tone',
  polite: 'Use a polite, respectful, and formal tone',
  business: 'Use a formal, professional business tone',
};

const styleInstruction = (style: string) => STYLE_PROMPTS[style as TranslationStyle] || STYLE_PROMPTS.casual;

chrome.runtime.onStartup.addListener(() => void syncOllamaCors());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.ollamaUrl) void syncOllamaCors();
});

/** Cancellable requests in flight, by requestKey() (sender frame + requestId). */
const inFlight = new Map<string, AbortController>();

/** Run `work` with an AbortSignal the sender can trigger with a `cancel` message. */
function cancellable<T>(
  sender: chrome.runtime.MessageSender,
  requestId: string | undefined,
  work: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!requestId) return work();
  const key = requestKey(sender, requestId);
  inFlight.get(key)?.abort();
  const ctrl = new AbortController();
  inFlight.set(key, ctrl);
  return work(ctrl.signal).finally(() => {
    if (inFlight.get(key) === ctrl) inFlight.delete(key);
  });
}

onTargetMessage<TranslatorRequest>(TRANSLATOR_TARGET, (request, sender) => {
  const refused = rejectReason(request, sender, chrome.runtime.id);
  if (refused) return fail(refused);
  switch (request.type) {
    case 'translate':
      return reply<'translate'>(
        cancellable(sender, request.requestId, (signal) =>
          handleTranslate(request.text, request.sourceLang, request.targetLang, request.style, signal),
        ).then((translation) => ({ translation })),
      );
    case 'cancel':
      inFlight.get(requestKey(sender, request.requestId))?.abort();
      return ok({});
    case 'fetch-ollama-models':
      return reply<'fetch-ollama-models'>(fetchOllamaModels(request.url).then((models) => ({ models })));
    case 'translate-batch':
      return reply<'translate-batch'>(
        cancellable(sender, request.requestId, (signal) =>
          handleTranslateBatch(request.texts, request.sourceLang, request.targetLang, request.style, signal),
        ).then((translations) => ({ translations })),
      );
    case 'grammar-check':
      return reply<'grammar-check'>(
        cancellable(sender, request.requestId, (signal) => handleGrammarCheck(request.text, signal)),
      );
    case 'devdy-status':
      return reply<'devdy-status'>(devdyTranslateStatus().then((status) => ({ status })));
    case 'open-devdy-settings':
      return reply<'open-devdy-settings'>(openSettings().then(() => ({})));
  }
});

// Streamed selection translation: one port per request, disconnect = cancel.
chrome.runtime.onConnect.addListener((port) => {
  serveStreamPort(port, {
    extensionId: chrome.runtime.id,
    translate: handleStreamTranslate,
    errorEvent: (err) => {
      const devdySettings = err instanceof DevdyTranslateError && needsDevdySettings(err.code);
      return { type: 'error', error: errorMessage(err), ...(devdySettings && { devdySettings }) };
    },
  });
});

async function handleStreamTranslate(
  request: StreamTranslateRequest,
  signal: AbortSignal,
  post: (event: StreamTranslateEvent) => void,
): Promise<string> {
  if ((await activeProvider()) === 'devdy') {
    return translateTextWithDevdy(request.text, request.targetLang, {
      signal,
      onDelta: (delta) => post({ type: 'delta', delta }),
      onSegment: (text) => post({ type: 'segment', text }),
    });
  }
  // LLM providers answer in one piece.
  const { style } = (await chrome.storage.sync.get({ style: DEFAULT_SETTINGS.style })) as { style: string };
  return handleTranslate(request.text, request.sourceLang, request.targetLang, style, signal);
}

/** The payload of a successful response to request type `K`. */
type Payload<K extends keyof TranslatorResponses> = Omit<Extract<TranslatorResponses[K], { ok: true }>, 'ok'>;

/** Wrap a handler's value (or error) in the response type of request type `K`. */
function reply<K extends keyof TranslatorResponses>(work: Promise<Payload<K>>): Promise<Result<Payload<K>>> {
  return work.then(ok, fail);
}

/** fetch() that gives up after `timeoutMs`, with readable connection/timeout errors. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: signalWithTimeout(signal, timeoutMs) });
  } catch (err) {
    if (signal?.aborted) throw new Error(CANCELLED);
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`No response from ${url} after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`Cannot connect to ${url} — ${errorMessage(err)}`);
  }
}

async function fetchOllamaModels(url: string): Promise<string[]> {
  const base = (url || DEFAULT_SETTINGS.ollamaUrl).replace(/\/+$/, '');
  await syncOllamaCors(base);
  try {
    const response = await fetchWithTimeout(`${base}/api/tags`, {}, MODELS_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}`);
    }
    const data = (await response.json()) as { models?: { name: string }[] };
    return (data.models || []).map((m) => m.name);
  } finally {
    // The probed URL is allowed for this fetch only; the saved URL keeps its rule.
    void syncOllamaCors('');
  }
}

/** The saved provider (default when unset or unknown). */
async function activeProvider(): Promise<Provider> {
  const { provider } = await chrome.storage.sync.get('provider');
  return isProvider(provider) ? provider : DEFAULT_SETTINGS.provider;
}

interface ProviderConfig {
  provider: LLMProvider;
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

  if (provider === 'devdy') {
    // Devdy requests never go through callLLM (see ./devdy.ts).
    throw new Error('Devdy is not an LLM API provider.');
  }

  if (provider === 'ollama') {
    if (!data.ollamaModel) {
      throw new Error('No Ollama model selected. Open extension settings and select a model.');
    }
    const base = (data.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/+$/, '');
    await syncOllamaCors();
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

/** truncated = the model hit its output limit. `json` = ask for a JSON reply. */
async function callLLM(
  systemPrompt: string,
  userContent: string,
  json = false,
  signal?: AbortSignal,
): Promise<LLMReply> {
  const config = await getCachedProviderConfig();
  const body = buildRequestBody(config.provider, config.model, systemPrompt, userContent, json);

  const response = await fetchWithTimeout(
    config.url,
    { method: 'POST', headers: config.headers, body: JSON.stringify(body) },
    config.provider === 'ollama' ? OLLAMA_TIMEOUT_MS : LLM_TIMEOUT_MS,
    signal,
  );

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
  signal?: AbortSignal,
): Promise<BatchTranslation[]> {
  if (texts.length === 0) return [];
  if ((await activeProvider()) === 'devdy') return translateBatchWithDevdy(texts, targetLang, signal);
  const systemPrompt = buildBatchPrompt(
    languageName(sourceLang),
    languageName(targetLang),
    styleInstruction(style),
    texts.length,
  );
  const { text: raw } = await callLLM(systemPrompt, buildBatchInput(texts), true, signal);
  return parseBatchResponse(raw, texts);
}

async function handleGrammarCheck(
  text: string,
  signal?: AbortSignal,
): Promise<{ corrected: string; issues?: GrammarIssue[] }> {
  if ((await activeProvider()) === 'devdy') {
    // Any language, corrected as is; explanations in the user's target language.
    const { targetLang } = await loadSettings('targetLang');
    return checkGrammarWithDevdy(text, targetLang, signal);
  }
  const systemPrompt =
    'You are an English grammar and spelling corrector. Fix grammar, spelling, ' +
    'and punctuation while preserving the original meaning and tone. Return ONLY ' +
    'the corrected English text — no explanations, quotes, or extra formatting. ' +
    'If it is already correct, return it unchanged.';

  const { text: corrected } = await callLLM(systemPrompt, text, false, signal);
  return { corrected };
}

const TRUNCATED_NOTICE = '\n\n⚠️ The translation may be incomplete: the AI model stopped at its output limit.';

async function handleTranslate(
  text: string,
  sourceLang: string,
  targetLang: string,
  style: string,
  signal?: AbortSignal,
): Promise<string> {
  if ((await activeProvider()) === 'devdy') return translateTextWithDevdy(text, targetLang, { signal });
  const systemPrompt = buildTranslatePrompt(
    languageName(sourceLang),
    languageName(targetLang),
    styleInstruction(style),
  );

  // Long selections are translated in chunks so no request exceeds the
  // model's context/output limits; whitespace between chunks is kept as-is.
  const segments = splitForTranslation(text, CHUNK_CHARS);
  const { provider } = await getCachedProviderConfig();
  const concurrency = provider === 'ollama' ? 1 : 3;
  let truncated = false;

  const parts = await mapLimit(segments, concurrency, async (segment) => {
    const { lead, core, trail } = splitOuterWhitespace(segment);
    if (!core) return segment;
    if (signal?.aborted) throw new Error(CANCELLED);
    const result = await callLLM(systemPrompt, wrapText(core), false, signal);
    if (result.truncated) truncated = true;
    return lead + stripTextTags(result.text) + trail;
  });

  return parts.join('').trim() + (truncated ? TRUNCATED_NOTICE : '');
}
