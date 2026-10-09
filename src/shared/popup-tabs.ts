// Popup shell tabs: ids, storage keys and the tab-switch request that tool
// pages (iframes of the shell) post to their parent.

export type ToolId = 'translator' | 'web-to-md' | 'slack' | 'devdy';

/** chrome.storage.local: tab shown last (restored next time). */
export const LAST_TAB_KEY = 'contextKitLastTab';
/** chrome.storage.local: one-shot request to open a given tab (read and cleared by the shell). */
export const OPEN_TAB_KEY = 'contextKitOpenTab';
/** `postMessage` type a tool page sends to the shell to switch tab. */
export const OPEN_TAB_MESSAGE = 'context-kit-open-tab';

/** From a tool page inside the shell: switch the shell to `tool`. */
export function requestOpenTab(tool: ToolId): void {
  window.parent.postMessage({ type: OPEN_TAB_MESSAGE, tool }, location.origin);
}
