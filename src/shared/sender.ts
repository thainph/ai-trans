// Who sent a runtime message / opened a port (pure checks + runtime-bound
// wrappers). The one definition of the sender kinds used by every feature;
// each feature keeps its own allow-list policy (which kind may send what).
//
// - extension sender: any context of THIS extension (pages, service worker,
//   offscreen document, content scripts) — `sender.id` is our id.
// - extension page: an extension sender whose URL is one of our pages
//   (chrome-extension://<id>/…): popup, offscreen document, service worker.
//   Content scripts report the web page's URL, so they never qualify.
// - content script from origin X: an extension sender whose frame URL has
//   origin X (e.g. https://app.slack.com).

/** The MessageSender fields the checks read (chrome.runtime.MessageSender is assignable). */
export interface SenderInfo {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { id?: number; url?: string };
}

/** `chrome-extension://<id>/` */
export const extensionBaseUrl = (extensionId: string): string => `chrome-extension://${extensionId}/`;

/** Any context of this extension, content scripts included. */
export function isExtensionSender(sender: SenderInfo, extensionId: string): boolean {
  return sender.id === extensionId;
}

/** One of this extension's own pages (popup, offscreen document) or its service worker. */
export function isExtensionPage(sender: SenderInfo, extensionId: string): boolean {
  return (
    isExtensionSender(sender, extensionId) &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(extensionBaseUrl(extensionId))
  );
}

/** This extension's content script running in a frame of `origin` (exact origin match). */
export function isContentScriptFrom(sender: SenderInfo, extensionId: string, origin: string): boolean {
  if (!isExtensionSender(sender, extensionId)) return false;
  try {
    return new URL(sender.url ?? '').origin === origin;
  } catch {
    return false;
  }
}

// Bound to the running extension (service worker / offscreen document).

export const fromExtension = (sender: SenderInfo): boolean => isExtensionSender(sender, chrome.runtime.id);
export const fromExtensionPage = (sender: SenderInfo): boolean => isExtensionPage(sender, chrome.runtime.id);
export const fromContentScriptOf = (sender: SenderInfo, origin: string): boolean =>
  isContentScriptFrom(sender, chrome.runtime.id, origin);
