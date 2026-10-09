// Translator allow-list: which sender kind (src/shared/sender.ts) may send which
// request, plus request validation (pure → unit-tested).

import { isExtensionPage, isExtensionSender } from '../../../shared/sender';
import { MAX_BATCH_ITEMS, MAX_TEXT_CHARS, type TranslatorRequest } from '../shared/messages';

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
    case 'translate':
    case 'grammar-check':
      if (request.requestId !== undefined && !isRequestId(request.requestId)) return 'Invalid request';
      return isText(request.text) ? null : 'Invalid or too long text';
    case 'cancel':
      return isRequestId(request.requestId) ? null : 'Invalid request';
    case 'translate-batch': {
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
