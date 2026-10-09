// Who may send which translator request (pure → unit-tested).

import type { TranslatorRequest } from '../shared/messages';

/** Upper bounds of one request, so a misbehaving frame can't run up the bill. */
export const MAX_TEXT_CHARS = 100_000;
export const MAX_BATCH_ITEMS = 200;

/** Sent by this extension (content script or extension page). */
export function isOwnSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  return sender.id === extensionId;
}

/** Sent by one of this extension's own pages (popup, options…), not a content script. */
export function isExtensionPage(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  const origin = `chrome-extension://${extensionId}`;
  return sender.id === extensionId && (sender.origin === origin || !!sender.url?.startsWith(`${origin}/`));
}

/** Why the request is refused, or null when it is allowed. */
export function rejectReason(
  request: TranslatorRequest,
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): string | null {
  if (!isOwnSender(sender, extensionId)) return 'Unknown sender';
  const isText = (t: unknown) => typeof t === 'string' && t.length <= MAX_TEXT_CHARS;
  switch (request.type) {
    case 'fetch-ollama-models':
      if (!isExtensionPage(sender, extensionId)) return 'Not allowed from a web page';
      return typeof request.url === 'string' ? null : 'Invalid request';
    case 'translate':
    case 'grammar-check':
      return isText(request.text) ? null : 'Invalid or too long text';
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
