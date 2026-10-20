// Translator settings in chrome.storage.sync: the single source of truth for
// keys, types and defaults (background, content script and popup).

/** `devdy`: Devdy's local Inbox API (engine, model and style are chosen in Devdy). */
export const PROVIDERS = ['openai', 'gemini', 'ollama', 'devdy'] as const;
export type Provider = (typeof PROVIDERS)[number];
/** Providers called directly with an LLM API. */
export type LLMProvider = Exclude<Provider, 'devdy'>;
export type TranslationStyle = 'casual' | 'polite' | 'business';

export interface TranslatorSettings {
  provider: Provider;
  /** OpenAI API key. */
  apiKey: string;
  openaiModel: string;
  geminiApiKey: string;
  geminiModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  style: TranslationStyle;
  /** Language id (see LANGUAGES). */
  targetLang: string;
  /** Selection popup size in px (resized by the user); height 0 = automatic. */
  popupWidth: number;
  popupHeight: number;
}

export const DEFAULT_SETTINGS: TranslatorSettings = {
  provider: 'openai',
  apiKey: '',
  openaiModel: 'gpt-4o-mini',
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  style: 'casual',
  targetLang: 'vietnamese',
  popupWidth: 340,
  popupHeight: 0,
};

export function isProvider(v: unknown): v is Provider {
  return (PROVIDERS as readonly unknown[]).includes(v);
}

/** Devdy applies its own translation style: the style setting is ignored. */
export const providerHasStyle = (provider: Provider): boolean => provider !== 'devdy';
/** Devdy checks grammar in any language (the LLM providers' prompt is English-only). */
export const providerGrammarIsEnglishOnly = (provider: Provider): boolean => provider !== 'devdy';

/** Defaults written to storage on install/update (never secrets). */
export const SEEDED_SETTINGS: Partial<TranslatorSettings> = {
  targetLang: DEFAULT_SETTINGS.targetLang,
  style: DEFAULT_SETTINGS.style,
  popupWidth: DEFAULT_SETTINGS.popupWidth,
  provider: DEFAULT_SETTINGS.provider,
  ollamaUrl: DEFAULT_SETTINGS.ollamaUrl,
  ollamaModel: DEFAULT_SETTINGS.ollamaModel,
  openaiModel: DEFAULT_SETTINGS.openaiModel,
  geminiModel: DEFAULT_SETTINGS.geminiModel,
};

/** Read some settings, falling back to their defaults. */
export async function loadSettings<K extends keyof TranslatorSettings>(
  ...keys: K[]
): Promise<Pick<TranslatorSettings, K>> {
  const defaults = Object.fromEntries(keys.map((k) => [k, DEFAULT_SETTINGS[k]])) as Pick<TranslatorSettings, K>;
  return (await chrome.storage.sync.get(defaults)) as Pick<TranslatorSettings, K>;
}

export function saveSettings(values: Partial<TranslatorSettings>): Promise<void> {
  return chrome.storage.sync.set(values);
}
