// Who sent a runtime message (pure, unit-tested). Privileged commands (Devdy
// settings, outbox, offscreen fetches/zips) are accepted only from this
// extension's own pages and service worker — never from content scripts,
// which run inside arbitrary web pages.

export interface SenderInfo {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { url?: string };
}

/** `extensionUrl` = `chrome.runtime.getURL('')` (e.g. "chrome-extension://<id>/"). */
export function isExtensionSender(sender: SenderInfo, extensionId: string, extensionUrl: string): boolean {
  if (sender.id !== extensionId) return false;
  // Content scripts report the web page's URL; extension pages and the SW report ours.
  return typeof sender.url === 'string' && sender.url.startsWith(extensionUrl);
}

/** A content script running in the top frame or a subframe of an app.slack.com tab. */
export function isSlackContentSender(sender: SenderInfo, extensionId: string): boolean {
  if (sender.id !== extensionId) return false;
  try {
    return new URL(sender.url ?? '').origin === 'https://app.slack.com';
  } catch {
    return false;
  }
}
