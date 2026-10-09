// Translator messages.
//
// content script / popup ─TRANSLATOR_TARGET─▶ background   (LLM calls)
// popup ─TRANSLATOR_PAGE_TARGET─▶ content script  (full-page translation)

import type { Result } from '../../../shared/messaging';
import type { TranslationStyle } from './settings';

export const TRANSLATOR_TARGET = 'context-kit-translator';
export const TRANSLATOR_PAGE_TARGET = 'context-kit-translator-page';

interface LangPair {
  sourceLang: string;
  targetLang: string;
  style: TranslationStyle;
}

export type TranslatorRequest =
  | ({ target: typeof TRANSLATOR_TARGET; type: 'translate'; text: string } & LangPair)
  /** Full-page translation: many short texts in one numbered prompt. */
  | ({ target: typeof TRANSLATOR_TARGET; type: 'translate-batch'; texts: string[] } & LangPair)
  | { target: typeof TRANSLATOR_TARGET; type: 'grammar-check'; text: string }
  | { target: typeof TRANSLATOR_TARGET; type: 'fetch-ollama-models'; url: string };

/** Response type per request type. */
export interface TranslatorResponses {
  translate: Result<{ translation: string }>;
  'translate-batch': Result<{ translations: string[] }>;
  'grammar-check': Result<{ corrected: string }>;
  'fetch-ollama-models': Result<{ models: string[] }>;
}

export type PageTranslationState = 'idle' | 'translating' | 'translated';

export type TranslatorPageRequest =
  | { target: typeof TRANSLATOR_PAGE_TARGET; type: 'translate-page' }
  | { target: typeof TRANSLATOR_PAGE_TARGET; type: 'revert-page' }
  | { target: typeof TRANSLATOR_PAGE_TARGET; type: 'get-state' };

export type PageStateResponse = Result<{ state: PageTranslationState }>;

/** A request without its `target` (distributes over the union). */
type Command<R> = R extends { target: string } ? Omit<R, 'target'> : never;

/** Send a request to the translator background; rejects when the runtime fails. */
export function callTranslator<C extends Command<TranslatorRequest>>(
  command: C,
): Promise<TranslatorResponses[C['type']] | undefined> {
  return chrome.runtime.sendMessage({ target: TRANSLATOR_TARGET, ...command });
}
