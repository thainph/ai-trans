// Sender checks against the running extension (see core/sender.ts).

import { isExtensionSender, isSlackContentSender } from '../core/sender';

/** Message from one of this extension's pages or its service worker. */
export function fromExtension(sender: chrome.runtime.MessageSender): boolean {
  return isExtensionSender(sender, chrome.runtime.id, chrome.runtime.getURL(''));
}

/** Message from the Slack content script (app.slack.com). */
export function fromSlackContent(sender: chrome.runtime.MessageSender): boolean {
  return isSlackContentSender(sender, chrome.runtime.id);
}
