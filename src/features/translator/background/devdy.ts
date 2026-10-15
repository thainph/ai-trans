// Translator with the Devdy provider (service worker side): selection texts
// split into ≤ 8000-char segments translated one after another, and full-page
// batches packed into marker-delimited documents (core/devdy-pack.ts).
// Devdy is reached only through the Devdy service API.

import {
  DEVDY_TRANSLATE_MAX_CHARS,
  DevdyTranslateError,
  type DevdyTranslateErrorCode,
  devdyTranslate,
} from '../../devdy/api';
import { DEVDY_PACK_CHARS, packItems, planPacks, unpackItems } from '../core/devdy-pack';
import { devdyTargetLang } from '../shared/languages';
import { splitForTranslation, splitOuterWhitespace } from './llm';

export const DEVDY_NO_GRAMMAR = 'Grammar check is not available with the Devdy provider.';

export interface DevdyTextOptions {
  signal?: AbortSignal;
  /** Stream: new text of the segment being translated. */
  onDelta?: (delta: string) => void;
  /** A segment is finished (its final text, outer whitespace kept). */
  onSegment?: (text: string) => void;
}

/** Translate a selection of any length (≤ MAX_TEXT_CHARS) into the translator language `targetLang`. */
export async function translateTextWithDevdy(
  text: string,
  targetLang: string,
  { signal, onDelta, onSegment }: DevdyTextOptions = {},
): Promise<string> {
  const target = devdyTargetLang(targetLang);
  // Devdy serializes translations anyway: segments go one after another.
  const parts: string[] = [];
  for (const segment of splitForTranslation(text, DEVDY_TRANSLATE_MAX_CHARS)) {
    const { lead, core, trail } = splitOuterWhitespace(segment);
    const part = core
      ? lead + (await devdyTranslate({ text: core, targetLang: target, signal, onDelta })).trim() + trail
      : segment;
    parts.push(part);
    onSegment?.(part);
  }
  return parts.join('').trim();
}

/** Errors that only concern one packed request: its items are retried later. */
const PACK_LOCAL_ERRORS: DevdyTranslateErrorCode[] = ['engine_error', 'timeout', 'interrupted', 'protocol', 'too_long'];

/**
 * Full-page batch: one translation or null per text. Texts are packed into
 * as few requests as possible, sent one at a time. Connection / token /
 * engine-unavailable errors fail the whole batch (shown to the user).
 */
export async function translateBatchWithDevdy(texts: string[], targetLang: string): Promise<(string | null)[]> {
  const target = devdyTargetLang(targetLang);
  const out: (string | null)[] = texts.map(() => null);
  const { groups } = planPacks(texts, DEVDY_PACK_CHARS);
  for (const group of groups) {
    let reply: string;
    try {
      reply = await devdyTranslate({ text: packItems(group.map((i) => texts[i]!)), targetLang: target });
    } catch (err) {
      if (err instanceof DevdyTranslateError && PACK_LOCAL_ERRORS.includes(err.code)) {
        console.warn('[context-kit] Devdy page batch failed:', err.code, err.detail);
        continue;
      }
      throw err;
    }
    unpackItems(reply, group.length).forEach((translation, j) => {
      out[group[j]!] = translation;
    });
  }
  return out;
}
