// Translator allow-list: which sender kind (src/shared/sender.ts) may send which
// request, plus request validation (pure → unit-tested).

import { isExtensionPage, isExtensionSender } from '../../../shared/sender';
import {
  MAX_BATCH_ITEMS,
  MAX_TEXT_CHARS,
  type StreamTranslateRequest,
  TRANSLATOR_STREAM_PORT,
  type TranslatorRequest,
} from '../shared/messages';

const isRequestId = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 64;

/** Key of a cancellable request: scoped to the sending frame, so a frame can only cancel its own. */
export function requestKey(sender: chrome.runtime.MessageSender, requestId: string): string {
  return `${sender.tab?.id ?? 'ext'}:${sender.frameId ?? 0}:${sender.documentId ?? ''}:${requestId}`;
}

/** Why the request is refused, or null when it is allowed. */
export function rejectReason(
  request: TranslatorRequest,
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): string | null {
  if (!isExtensionSender(sender, extensionId)) return 'Unknown sender';
  const isText = (t: unknown) => typeof t === 'string' && t.length <= MAX_TEXT_CHARS;
  switch (request.type) {
    case 'fetch-ollama-models':
      if (!isExtensionPage(sender, extensionId)) return 'Not allowed from a web page';
      return typeof request.url === 'string' ? null : 'Invalid request';
    case 'devdy-status':
      return isExtensionPage(sender, extensionId) ? null : 'Not allowed from a web page';
    case 'open-devdy-settings':
      // Only switches the popup to the Devdy tab (offered after a token error).
      return null;
    case 'translate':
    case 'grammar-check':
      if (request.requestId !== undefined && !isRequestId(request.requestId)) return 'Invalid request';
      return isText(request.text) ? null : 'Invalid or too long text';
    case 'cancel':
      return isRequestId(request.requestId) ? null : 'Invalid request';
    case 'translate-batch': {
      if (request.requestId !== undefined && !isRequestId(request.requestId)) return 'Invalid request';
      const { texts } = request;
      const valid =
        Array.isArray(texts) &&
        texts.length <= MAX_BATCH_ITEMS &&
        texts.every((t) => typeof t === 'string') &&
        texts.reduce((n, t) => n + t.length, 0) <= MAX_TEXT_CHARS;
      return valid ? null : 'Invalid or too large batch';
    }
    default:
      return 'Unknown request';
  }
}

/** Who may open the streaming port: any context of this extension (content scripts included). */
export function streamPortRejectReason(
  port: { name: string; sender?: chrome.runtime.MessageSender },
  extensionId: string,
): string | null {
  if (port.name !== TRANSLATOR_STREAM_PORT) return 'Unknown port';
  return port.sender && isExtensionSender(port.sender, extensionId) ? null : 'Unknown sender';
}

/** A well-formed `translate` message on the streaming port (same text limit as `translate`). */
export function isStreamRequest(msg: unknown): msg is StreamTranslateRequest {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === 'translate' &&
    typeof m.text === 'string' &&
    m.text.length <= MAX_TEXT_CHARS &&
    typeof m.sourceLang === 'string' &&
    m.sourceLang.length <= 64 &&
    typeof m.targetLang === 'string' &&
    m.targetLang.length <= 64
  );
}
