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

/** Upper bounds of one request (checked by the service worker). */
export const MAX_TEXT_CHARS = 100_000;
export const MAX_BATCH_ITEMS = 200;

export type TranslatorRequest =
  /** `requestId` (optional): lets the sender abort it with `cancel`. */
  | ({ target: typeof TRANSLATOR_TARGET; type: 'translate'; text: string; requestId?: string } & LangPair)
  /** Full-page translation: many short texts in one JSON-array prompt. */
  | ({ target: typeof TRANSLATOR_TARGET; type: 'translate-batch'; texts: string[] } & LangPair)
  | { target: typeof TRANSLATOR_TARGET; type: 'grammar-check'; text: string; requestId?: string }
  /** Abort the sender frame's request `requestId` (no-op when already done). */
  | { target: typeof TRANSLATOR_TARGET; type: 'cancel'; requestId: string }
  | { target: typeof TRANSLATOR_TARGET; type: 'fetch-ollama-models'; url: string };

/** Response type per request type. */
export interface TranslatorResponses {
  translate: Result<{ translation: string }>;
  /** One entry per text; null = no usable translation (retry later, don't cache). */
  'translate-batch': Result<{ translations: (string | null)[] }>;
  'grammar-check': Result<{ corrected: string }>;
  cancel: Result;
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
