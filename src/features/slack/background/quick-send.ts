// "Send to Devdy" without the popup, from the item the content script injects
// into Slack's own message menu. Progress and results are shown as a toast
// inside the Slack tab.

import { type Result, onTargetMessage } from '../../../shared/messaging';
import { openSettings } from '../../devdy/background/open-settings';
import { toastFor } from '../core/quick-send';
import {
  QUICK_SEND_OPTIONS,
  QUICK_SEND_TARGET,
  type QuickSendRequest,
  TOAST_TARGET,
  type ToastMessage,
} from '../quick-send-messages';
import { exportErrorMessage, handleExport } from './export';

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
    toast(tabId, frameId, { target: TOAST_TARGET, key, state: 'error', text: exportErrorMessage(e) });
  } finally {
    inFlight.delete(link);
  }
}

onTargetMessage<QuickSendRequest>(QUICK_SEND_TARGET, (msg, sender): Result | undefined => {
  switch (msg.type) {
    case 'devdy-send': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return;
      void quickSend(msg.link, tabId, sender.frameId);
      return { ok: true }; // accepted; progress/result arrive as toasts
    }
    case 'open-settings':
      void openSettings();
      return { ok: true };
  }
});
