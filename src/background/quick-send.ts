// "Send to Devdy" without the popup:
//  • from the item the content script injects into Slack's own message menu
//  • from the browser context menu on app.slack.com (fallback when Slack's
//    menu markup changes and the injected item cannot be placed)
// Progress and results are shown as a toast inside the Slack tab.

import { resolveContextMenuLink, toastFor } from '../core/quick-send';
import { SlackExportError } from '../core/slack-client';
import {
  CONTENT_TARGET,
  type ContentQueryResponse,
  QUICK_SEND_OPTIONS,
  QUICK_SEND_TARGET,
  type QuickSendRequest,
  TOAST_TARGET,
  type ToastMessage,
} from '../types/quick-send';
import { handleExport } from './slack-export';

const MENU_ID = 'context-kit-send-to-devdy';
const SLACK_PAGES = ['https://app.slack.com/*'];

/** Threads currently being sent (avoid double sends from repeated clicks). */
const inFlight = new Set<string>();

function toast(tabId: number, frameId: number | undefined, msg: ToastMessage): void {
  const opts = frameId !== undefined ? { frameId } : undefined;
  chrome.tabs.sendMessage(tabId, msg, opts).catch(() => {
    // Tab closed / content script not injected: the send still completes.
  });
}

export async function quickSend(link: string, tabId: number, frameId?: number): Promise<void> {
  const key = crypto.randomUUID();
  if (inFlight.has(link)) {
    toast(tabId, frameId, { target: TOAST_TARGET, key, state: 'progress', text: 'Already sending this thread…' });
    return;
  }
  inFlight.add(link);
  toast(tabId, frameId, { target: TOAST_TARGET, key, state: 'progress', text: 'Sending thread to Devdy…' });
  try {
    await handleExport(
      { type: 'export', link, action: 'devdy', options: QUICK_SEND_OPTIONS },
      (msg) => {
        const t = toastFor(msg, key);
        if (t) toast(tabId, frameId, t);
      },
      tabId,
    );
  } catch (e) {
    const text =
      e instanceof SlackExportError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    toast(tabId, frameId, { target: TOAST_TARGET, key, state: 'error', text });
  } finally {
    inFlight.delete(link);
  }
}

async function openSettings(): Promise<void> {
  try {
    // The popup opens on the Slack tab (active tab is app.slack.com) → Devdy panel.
    await chrome.action.openPopup();
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/index.html') });
  }
}

chrome.runtime.onMessage.addListener((msg: QuickSendRequest, sender, sendResponse) => {
  if (msg?.target !== QUICK_SEND_TARGET) return;
  if (msg.type === 'devdy-send') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    void quickSend(msg.link, tabId, sender.frameId);
    sendResponse({ accepted: true });
  } else if (msg.type === 'open-settings') {
    void openSettings();
    sendResponse({ ok: true });
  }
});

// ---- Browser context menu (fallback) -----------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Send Slack thread to Devdy',
      contexts: ['page', 'link', 'selection', 'image'],
      documentUrlPatterns: SLACK_PAGES,
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
  let lastContextLink: string | undefined;
  try {
    const res = (await chrome.tabs.sendMessage(
      tab.id,
      { target: CONTENT_TARGET, type: 'last-context-link' },
      { frameId: info.frameId ?? 0 },
    )) as ContentQueryResponse | undefined;
    lastContextLink = res?.link;
  } catch {
    // content script not available
  }
  const link = resolveContextMenuLink({ linkUrl: info.linkUrl, lastContextLink, tabUrl: tab.url });
  if (!link) {
    toast(tab.id, info.frameId, {
      target: TOAST_TARGET,
      key: crypto.randomUUID(),
      state: 'error',
      text: 'Right-click a message (or open its thread) to send it to Devdy.',
    });
    return;
  }
  await quickSend(link, tab.id, info.frameId);
});
