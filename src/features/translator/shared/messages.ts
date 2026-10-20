// Translator messages.
//
// content script / popup ─TRANSLATOR_TARGET─▶ background   (LLM calls)
// popup ─TRANSLATOR_PAGE_TARGET─▶ content script  (full-page translation)
// content script ─port TRANSLATOR_STREAM_PORT─▶ background  (streamed selection translation)

import type { Command, Result } from '../../../shared/messaging';
import type { TranslationStyle } from './settings';

export const TRANSLATOR_TARGET = 'context-kit-translator';
export const TRANSLATOR_PAGE_TARGET = 'context-kit-translator-page';

interface LangPair {
  sourceLang: string;
  targetLang: string;
  style: TranslationStyle;
}

/** One fix of a grammar check: `original` is the passage as written (no offsets). */
export interface GrammarIssue {
  original: string;
  suggestion: string;
  /** Short reason, in the translator's target language (may be empty). */
  explanation: string;
}

/** Error of a request aborted by its sender (`cancel`, revert, port disconnect). */
export const CANCELLED = 'Cancelled';

/** Upper bounds of one request (checked by the service worker). */
export const MAX_TEXT_CHARS = 100_000;
export const MAX_BATCH_ITEMS = 200;

export type TranslatorRequest =
  /** `requestId` (optional): lets the sender abort it with `cancel`. */
  | ({ target: typeof TRANSLATOR_TARGET; type: 'translate'; text: string; requestId?: string } & LangPair)
  /** Full-page translation: many short texts in one request. `requestId`: cancellable like `translate`. */
  | ({ target: typeof TRANSLATOR_TARGET; type: 'translate-batch'; texts: string[]; requestId?: string } & LangPair)
  | { target: typeof TRANSLATOR_TARGET; type: 'grammar-check'; text: string; requestId?: string }
  /** Abort the sender frame's request `requestId` (no-op when already done). */
  | { target: typeof TRANSLATOR_TARGET; type: 'cancel'; requestId: string }
  | { target: typeof TRANSLATOR_TARGET; type: 'fetch-ollama-models'; url: string }
  /** Devdy provider: is Devdy running, able to translate, with a valid token? (Translate tab) */
  | { target: typeof TRANSLATOR_TARGET; type: 'devdy-status' }
  /** Open AI Trans on the Devdy tab (token / instance choice), e.g. after a 401. */
  | { target: typeof TRANSLATOR_TARGET; type: 'open-devdy-settings' };

/** Response type per request type. */
export interface TranslatorResponses {
  translate: Result<{ translation: string }>;
  'translate-batch': Result<{ translations: BatchTranslation[] }>;
  /** `issues`: what was fixed and why (Devdy only; the other providers return the corrected text alone). */
  'grammar-check': Result<{ corrected: string; issues?: GrammarIssue[] }>;
  cancel: Result;
  'fetch-ollama-models': Result<{ models: string[] }>;
  'devdy-status': Result<{ status: DevdyStatusView }>;
  'open-devdy-settings': Result;
}

/** Devdy translation readiness as shown in the Translate tab. */
export interface DevdyStatusView {
  state: 'not_running' | 'choose_instance' | 'unsupported' | 'no_token' | 'unauthorized' | 'ready';
  port?: number;
  version?: string;
}

/**
 * Streamed selection translation (Devdy provider): one port per request.
 * The content script posts one `translate` message; disconnecting aborts it.
 */
export const TRANSLATOR_STREAM_PORT = 'context-kit-translator-stream';

export interface StreamTranslateRequest {
  type: 'translate';
  text: string;
  sourceLang: string;
  targetLang: string;
}

export type StreamTranslateEvent =
  /** New text of the segment being translated (display only). */
  | { type: 'delta'; delta: string }
  /** A segment of a long text is finished: its final text replaces its deltas. */
  | { type: 'segment'; text: string }
  /** Authoritative full translation. */
  | { type: 'done'; text: string }
  /** `devdySettings`: the fix is in AI Trans → Devdy (token / instance choice). */
  | { type: 'error'; error: string; devdySettings?: boolean };

/**
 * One entry per text of a batch: the translation; `null` = no usable
 * translation (retry later, don't cache); `false` = this provider can't take
 * the text (keep the original, don't retry).
 */
export type BatchTranslation = string | null | false;

export type PageTranslationState = 'idle' | 'translating' | 'translated';

export type TranslatorPageRequest =
  | { target: typeof TRANSLATOR_PAGE_TARGET; type: 'translate-page' }
  | { target: typeof TRANSLATOR_PAGE_TARGET; type: 'revert-page' }
  | { target: typeof TRANSLATOR_PAGE_TARGET; type: 'get-state' };

export type PageStateResponse = Result<{ state: PageTranslationState }>;

/** Send a request to the translator background; rejects when the runtime fails. */
export function callTranslator<C extends Command<TranslatorRequest>>(
  command: C,
): Promise<TranslatorResponses[C['type']] | undefined> {
  return chrome.runtime.sendMessage({ target: TRANSLATOR_TARGET, ...command });
}
